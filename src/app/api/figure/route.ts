import { NextRequest, NextResponse } from "next/server";
import {
  FigureImageError,
  figureImageModelIds,
  generateFigureImage,
  type FigureMode,
} from "@/lib/figureImageGen";
import { FIGURE_TOKEN_DEPOSIT, figureTokenCharge } from "@/lib/tokens";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
/**
 * 이미지 생성은 느리다. 제한을 넘기면 Vercel이 JSON이 아닌 에러 페이지를
 * 돌려줘서 클라이언트의 res.json()이 깨진다.
 *
 * **60초로는 모자랐다.** 운영 로그에서 문제 한 개 전체를 그리는 요청이
 * `Vercel Runtime Timeout Error: Task timed out after 60 seconds` 로 죽는 게
 * 확인됐다 — 같은 시간대에 성공한 것도 있어서, 60초 언저리에 걸쳐 있었다.
 * 품질을 낮춰 시간을 줄이는 건 답이 아니다(글자와 가는 선이 살아야 한다).
 */
export const maxDuration = 300;

/**
 * 우리가 먼저 손을 떼는 시각. maxDuration 보다 넉넉히 앞이어야 한다.
 *
 * **Vercel 이 함수를 죽이면 환불 코드가 아예 돌지 못한다** — 토큰(50)만 나가고
 * 아무것도 안 남는다. 실제로 그렇게 잃고 있었다. 우리가 먼저 끊으면 그 뒤를
 * 이어서 환불하고 사람이 읽을 수 있는 오류를 돌려줄 수 있다.
 * 남기는 여유는 환불 RPC 와 응답 직렬화에 쓴다.
 */
const DEADLINE_MS = (maxDuration - 15) * 1000;

/**
 * 모델을 갈아타며 재시도할 최대 횟수.
 *
 * 기본 설정에서는 모델이 하나뿐이라 실제로는 한 번만 시도한다. 예전에 후보를
 * 여러 개 두고 실패하면 다음으로 내려가게 했다가, 고른 적도 없는 모델에
 * 요금이 나갔다. 폴백은 OPENAI_FIGURE_IMAGE_MODELS로 명시했을 때만 생긴다.
 */
const MAX_MODEL_ATTEMPTS = 2;

/**
 * 못 낸 만큼을 그 문제에 적어 **잠근다**.
 *
 * 생성은 이미 끝났는데(=우리는 이미 돈을 냈는데) 사용자 잔액이 모자란 경우다.
 * 만든 그림을 버리지는 않되, 결제하기 전에는 그 문제를 쓰지 못하게 한다 —
 * 목록에서 가려지고 PDF 에서도 빠진다.
 *
 * 저장 위치는 `problems.box_range.debt` 다. 글자 크기·그림·번호를 거기 얹은
 * 것과 같은 이유로 **마이그레이션이 필요 없다.**
 *
 * **어느 문제인지 모르면 잠글 대상이 없다.** 그때는 초과분을 우리가 먹고 로그만
 * 남긴다 — 붙잡아 둘 대상이 없는데 조용히 빚을 지울 수는 없다.
 */
async function lockProblem(
  supabase: Awaited<ReturnType<typeof createClient>>,
  problemId: string | null,
  debt: number,
): Promise<void> {
  if (!problemId) {
    console.warn(
      `[api/figure] 잔액이 ${debt}토큰 모자라지만 대상 문제를 몰라 잠그지 못했습니다.`,
    );
    return;
  }
  try {
    const { data: row } = await supabase
      .from("problems")
      .select("box_range")
      .eq("id", problemId)
      .maybeSingle();
    const box = (row?.box_range ?? {}) as Record<string, unknown>;
    const before = typeof box.debt === "number" ? box.debt : 0;
    await supabase
      .from("problems")
      .update({ box_range: { ...box, debt: before + debt } })
      .eq("id", problemId);
    console.warn(
      `[api/figure] ${problemId} 를 ${before + debt}토큰 미납으로 잠갔습니다.`,
    );
  } catch (err) {
    console.error("[api/figure] 잠금 기록 실패:", err);
  }
}

/**
 * 다 그린 문제 이미지를 서버가 직접 저장한다.
 *
 * **브라우저를 닫아도 결과가 남게 하려는 것이다.** 생성은 1분쯤 걸리는데,
 * 그 사이에 탭을 닫거나 앱을 바꾸면 브라우저 쪽 fetch는 끊긴다. 그래도 이
 * 함수는 서버에서 끝까지 돌아 결과를 저장하므로, 토큰만 나가고 아무것도 안
 * 남는 일이 없다. 화면이 살아 있으면 화면이 더 예쁜 카드로 다시 저장하므로
 * 이건 "최소한 남기는" 보험이다.
 *
 * 실패해도 요청 자체는 성공으로 돌려준다 — 화면이 살아 있으면 그쪽이 저장하고,
 * 여기서 못 남긴 것 때문에 이미 만든 그림을 버릴 이유는 없다.
 */
async function persistWholeProblem(
  supabase: Awaited<ReturnType<typeof createClient>>,
  problemId: string,
  figureId: string | null,
  dataUrl: string,
): Promise<boolean> {
  try {
    const { data: row } = await supabase
      .from("problems")
      .select("image_path, box_range")
      .eq("id", problemId)
      .maybeSingle();
    if (!row?.image_path) return false;

    const base64 = dataUrl.split(",")[1];
    if (!base64) return false;
    const bytes = Buffer.from(base64, "base64");

    const dir = String(row.image_path).split("/").slice(0, -1).join("/");
    const newPath = `${dir}/${crypto.randomUUID()}.png`;
    const { error: upErr } = await supabase.storage
      .from("problem-images")
      .upload(newPath, bytes, { contentType: "image/png" });
    if (upErr) return false;

    // 그림 목록에서 이 그림의 마크업만 갈아끼운다. 화면이 저장해 둔 자리·크기는
    // 건드리지 않는다(사용자가 옮겨 놨을 수 있다).
    const box = (row.box_range ?? {}) as Record<string, unknown>;
    const figures = Array.isArray(box.figures)
      ? (box.figures as Record<string, unknown>[])
      : [];
    const markup = `<img src="${dataUrl}" alt="" />`;
    // 갈아치우기 전의 그림을 원본으로 남긴다. **이미 있으면 덮지 않는다** —
    // 두 번째 AI 결과가 첫 번째 AI 결과를 원본으로 만들어 버리면 안 된다.
    // 브라우저를 닫았을 때는 이 길로 저장되므로, 여기가 빠지면 탭을 닫고
    // 돌아온 문제에만 원본이 없어진다.
    const nextFigures =
      figures.length > 0
        ? figures.map((f) =>
            !figureId || f.id === figureId
              ? {
                  ...f,
                  ...(typeof f.origin === "string" ||
                  typeof f.markup !== "string"
                    ? {}
                    : { origin: f.markup }),
                  markup,
                  ai: true,
                }
              : f,
          )
        : [
            {
              id: figureId ?? crypto.randomUUID(),
              markup,
              layout: { scale: 100, offsetX: 0, offsetY: 0 },
              position: 0,
              kind: "figure",
            },
          ];

    const { error: dbErr } = await supabase
      .from("problems")
      .update({
        image_path: newPath,
        box_range: { ...box, figures: nextFigures },
      })
      .eq("id", problemId);
    if (dbErr) {
      await supabase.storage.from("problem-images").remove([newPath]);
      return false;
    }
    await supabase.storage
      .from("problem-images")
      .remove([String(row.image_path)]);
    return true;
  } catch (err) {
    console.error("[api/figure] 결과 저장 실패:", err);
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: {
    image?: string;
    mode?: string;
    problemId?: string;
    figureId?: string;
    reference?: string;
    instruction?: string;
    width?: number;
    height?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "잘못된 요청 본문입니다." },
      { status: 400 },
    );
  }

  const image = body.image;
  // "problem"이면 문제 한 개 전체를 다시 그린다(탐구). 프롬프트가 달라진다.
  const mode: FigureMode = body.mode === "problem" ? "problem" : "figure";
  // 문제 전체를 그리는 경우에는 결과를 **서버가 직접 저장**한다. 브라우저를
  // 닫아도 결과가 남게 하려는 것이다(자세한 이유는 persistWholeProblem 주석).
  const problemId = typeof body.problemId === "string" ? body.problemId : null;
  const figureId = typeof body.figureId === "string" ? body.figureId : null;
  // OCR 로 읽은 본문. 프롬프트에 덧붙여 글자를 베껴 쓰게 한다(문제 전체 전용).
  // 길이를 잘라 둔다 — 프롬프트가 무한정 길어질 이유가 없다.
  const reference =
    typeof body.reference === "string"
      ? body.reference.slice(0, 4000)
      : undefined;
  // 사용자가 적어 준 "이렇게 그려 주세요". 프롬프트 끝에 붙는다.
  // reference 와 같은 이유로 길이를 잘라 둔다.
  const instruction =
    typeof body.instruction === "string"
      ? body.instruction.slice(0, 500).trim() || undefined
      : undefined;
  // 보낸 그림의 픽셀 크기. 출력 캔버스를 이 비율에 맞추는 데 쓴다 — 비율이
  // 어긋나면 모델이 흰 여백을 붙여 주고 우리는 그걸 잘라 버리므로, 그 여백이
  // 곧 버리는 돈이다. 없으면 예전처럼 auto 로 둔다.
  const inputSize =
    typeof body.width === "number" &&
    typeof body.height === "number" &&
    body.width > 0 &&
    body.height > 0
      ? { width: body.width, height: body.height }
      : undefined;
  if (!image || typeof image !== "string") {
    return NextResponse.json(
      { error: "image(base64 data URL) 필드가 필요합니다." },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("[api/figure] OPENAI_API_KEY not set");
    return NextResponse.json(
      {
        error:
          "OPENAI_API_KEY가 설정되지 않아 자료 재구성 기능을 쓸 수 없습니다. 원본 이미지를 그대로 붙이는 방법을 이용해주세요.",
      },
      { status: 500 },
    );
  }

  const supabase = isSupabaseConfigured() ? await createClient() : null;
  /**
   * 무제한 계정인가.
   *
   * **차감도 잠금도 건너뛴다.** 예전에는 이 검사가 아예 없어서, 무제한인데
   * 잔액이 0 이면 402 로 막혔다(consume 이 `credits >= p_amount` 를 요구한다).
   * 무제한의 뜻과 어긋난다. 실제로 쓴 금액을 화면에 보여주는 것도 이 계정만이다.
   */
  let unlimited = false;
  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 },
      );
    }
    const { data: ent } = await supabase
      .from("entitlements")
      .select("unlimited")
      .eq("user_id", user.id)
      .maybeSingle();
    unlimited = ent?.unlimited === true;
  }

  // AI 그림 생성은 실제로 돈이 나가는 유료 API라 토큰으로 과금한다.
  //
  // **보증금을 먼저 걸고, 끝나면 실제로 쓴 값으로 정산한다.** 원가가 요청마다
  // 1.5배까지 널뛰어서 고정 요금은 어느 쪽으로도 틀린다. 선차감을 두는 이유는
  // 잔액이 없는 사람이 생성을 시작하지 못하게 하려는 것이다.
  //
  // 차감은 요청당 한 번이다 — 모델을 갈아타며 재시도하는 것은 우리 사정이지
  // 사용자가 더 낼 이유가 아니다.
  let charged = false;
  if (supabase && !unlimited) {
    try {
      const { data, error } = await supabase.rpc("consume_recognition_credit", {
        p_amount: FIGURE_TOKEN_DEPOSIT,
      });
      if (error) throw error;
      // 함수는 남은 크레딧을 돌려주고, 부족하면 null을 준다.
      if (data === null) {
        return NextResponse.json(
          {
            error: `토큰이 부족해요. AI 그림 생성에는 최소 ${FIGURE_TOKEN_DEPOSIT}토큰이 필요합니다.`,
          },
          { status: 402 },
        );
      }
      charged = true;
    } catch (rpcError) {
      console.error(
        "[api/figure] consume_recognition_credit rpc error:",
        rpcError,
      );
      const message =
        rpcError instanceof Error
          ? rpcError.message
          : "크레딧 차감에 실패했습니다.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  async function refund() {
    if (!supabase || !charged) return;
    try {
      await supabase.rpc("refund_recognition_credit", {
        p_amount: FIGURE_TOKEN_DEPOSIT,
      });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  /**
   * 보증금과 실제 값의 차이를 맞춘다. 돌려주는 것은 **실제로 물린 토큰 수**다.
   *
   * 모자란데 잔액이 없으면 그만큼을 미납으로 적어 그 문제를 잠근다
   * (`lockProblem`). 이미 그림은 만들어졌으므로 요청 자체는 성공으로 돌려준다 —
   * 만든 것을 버릴 이유가 없다.
   */
  async function settle(estKrw: number | undefined): Promise<number | null> {
    if (!supabase || !charged) return null;
    const want = figureTokenCharge(estKrw);
    if (estKrw === undefined) {
      console.warn(
        `[api/figure] usage 를 못 받아 폴백으로 ${want}토큰을 물립니다.`,
      );
    }
    const diff = want - FIGURE_TOKEN_DEPOSIT;
    try {
      if (diff < 0) {
        await supabase.rpc("refund_recognition_credit", { p_amount: -diff });
      } else if (diff > 0) {
        const { data } = await supabase.rpc("consume_recognition_credit", {
          p_amount: diff,
        });
        // null 이면 잔액이 모자란 것이다 — 미납으로 남기고 문제를 잠근다.
        if (data === null) await lockProblem(supabase, problemId, diff);
      }
    } catch (err) {
      console.error("[api/figure] 정산 실패:", err);
    }
    return want;
  }

  const modelIds = figureImageModelIds();
  let lastError: string | null = null;

  // 시간이 다 되면 우리가 먼저 끊는다(위 DEADLINE_MS 주석 참고).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);

  try {
    for (let i = 0; i < Math.min(modelIds.length, MAX_MODEL_ATTEMPTS); i++) {
      const modelId = modelIds[i];
      try {
        const result = await generateFigureImage(
          image,
          modelId,
          mode,
          reference,
          deadline.signal,
          inputSize,
          instruction,
        );
        if (!result) {
          await refund();
          return NextResponse.json(
            { error: "자료를 다시 그리지 못했습니다. 다시 시도해주세요." },
            { status: 502 },
          );
        }
        console.info(`[api/figure] ok model=${modelId}`);
        let persisted = false;
        if (supabase && mode === "problem" && problemId) {
          persisted = await persistWholeProblem(
            supabase,
            problemId,
            figureId,
            result.dataUrl,
          );
        }
        // 실제로 쓴 값으로 정산한다(보증금과의 차액을 맞춘다).
        const chargedTokens = await settle(result.usage?.estKrw);

        // **금액은 무제한 계정에만 보여준다.** 막는 자리는 서버다 — 화면에서
        // 숨기는 건 얼마든지 우회할 수 있다. 일반 사용자에게는 토큰 수만 준다.
        const usage = unlimited
          ? result.usage
          : result.usage && {
              inputText: result.usage.inputText,
              inputImage: result.usage.inputImage,
              output: result.usage.output,
              cached: result.usage.cached,
            };

        return NextResponse.json({
          image: result.dataUrl,
          modelId,
          persisted,
          usage,
          chargedTokens,
        });
      } catch (err) {
        // 시간이 다 돼 우리가 끊은 경우. 다음 모델로 내려가 봐야 남은 시간이
        // 없으므로 여기서 끝내고, **토큰을 돌려준다.**
        if (deadline.signal.aborted) {
          await refund();
          console.error(
            `[api/figure] ${maxDuration}초 안에 끝나지 않아 중단함`,
          );
          return NextResponse.json(
            {
              error: `이미지 생성이 ${maxDuration}초 안에 끝나지 않았습니다. 토큰은 돌려드렸어요. 문제 영역을 조금 좁게 잘라 다시 시도해주세요.`,
            },
            { status: 504 },
          );
        }

        // 404(없는 이름)/403(권한 없음)/429(한도)면 이 모델로는 안 된다.
        if (err instanceof FigureImageError && err.shouldTryNextModel) {
          console.warn(
            `[api/figure] ${modelId} 사용 불가(${err.status}), 다음 모델로 내려감`,
          );
          lastError = err.message;
          continue;
        }

        await refund();
        const message = err instanceof Error ? err.message : "알 수 없는 오류";
        console.error("[api/figure] unexpected error:", err);
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }

    await refund();
    console.error(
      `[api/figure] 쓸 수 있는 이미지 모델을 찾지 못함. 후보=${modelIds.join(", ")}`,
    );
    return NextResponse.json(
      {
        error:
          "쓸 수 있는 자료 생성 모델을 찾지 못했습니다. 관리자는 /api/figure/models 에서 이 키로 부를 수 있는 이미지 모델을 확인하고 OPENAI_FIGURE_IMAGE_MODELS 환경변수에 넣어주세요." +
          (lastError ? ` (마지막 오류: ${lastError})` : ""),
      },
      { status: 503 },
    );
  } finally {
    // 타이머를 꼭 지운다. 안 지우면 응답을 보낸 뒤에도 인스턴스가 살아 있는
    // 동안 타이머가 남아, 재사용된 인스턴스에서 엉뚱한 요청을 끊을 수 있다.
    clearTimeout(timer);
  }
}
