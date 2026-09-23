import { NextRequest, NextResponse } from "next/server";
import type { FigureMode } from "@/lib/figureImageGen";
import { FIGURE_TOKEN_DEPOSIT, figureTokenCharge } from "@/lib/tokens";
import { getBillingContext } from "@/lib/byok";
import {
  persistWholeProblem,
  pickModelIds,
  runFigureGeneration,
  visibleUsage,
} from "@/lib/figureRun";
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

export async function POST(req: NextRequest) {
  let body: {
    image?: string;
    mode?: string;
    korean?: boolean;
    problemId?: string;
    figureId?: string;
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
  const korean = body.korean === true;
  // 문제 전체를 그리는 경우에는 결과를 **서버가 직접 저장**한다. 브라우저를
  // 닫아도 결과가 남게 하려는 것이다(자세한 이유는 persistWholeProblem 주석).
  const problemId = typeof body.problemId === "string" ? body.problemId : null;
  const figureId = typeof body.figureId === "string" ? body.figureId : null;
  // 사용자가 적어 준 "이렇게 그려 주세요". 프롬프트 끝에 붙는다.
  // 프롬프트가 무한정 길어질 이유가 없어 길이를 잘라 둔다.
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

  const supabase = isSupabaseConfigured() ? await createClient() : null;
  /**
   * 무제한 계정 / BYOK 계정인가.
   *
   * **무제한은 차감도 잠금도 건너뛴다.** 예전에는 이 검사가 아예 없어서,
   * 무제한인데 잔액이 0 이면 402 로 막혔다(consume 이 `credits >= p_amount`
   * 를 요구한다). 무제한의 뜻과 어긋난다.
   *
   * **BYOK는 차감을 건너뛰고 본인 OpenAI 키로 직접 부른다** — 공유
   * `OPENAI_API_KEY`는 절대 건드리지 않는다(사용자 결정, item 5).
   */
  let unlimited = false;
  let byok = false;
  let byokApiKey: string | null = null;
  let byokModel: string | null = null;
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
    const billingCtx = await getBillingContext(supabase, user.id);
    unlimited = billingCtx.unlimited;
    byok = billingCtx.byok;
    byokApiKey = billingCtx.byokApiKey;
    byokModel = billingCtx.byokModel;
  }

  if (byok && !byokApiKey) {
    return NextResponse.json(
      {
        error:
          "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요.",
      },
      { status: 402 },
    );
  }

  if (!byok && !process.env.OPENAI_API_KEY) {
    console.error("[api/figure] OPENAI_API_KEY not set");
    return NextResponse.json(
      {
        error:
          "OPENAI_API_KEY가 설정되지 않아 자료 재구성 기능을 쓸 수 없습니다. 원본 이미지를 그대로 붙이는 방법을 이용해주세요.",
      },
      { status: 500 },
    );
  }

  // AI 그림 생성은 실제로 돈이 나가는 유료 API라 토큰으로 과금한다.
  //
  // **FIGURE_TOKEN_DEPOSIT을 고정으로 뗀다**(2026-09-17, 사용자 결정).
  // 예전엔 원가(96~143원)에 마진을 곱해 실사용량만큼만 받았는데, 지금은
  // 원가가 얼마든 항상 같은 금액이다 — 간단하고 예측 가능한 대신, 원가가
  // 이 값을 넘는 요청에서는 우리가 밑질 수 있다.
  //
  // 차감은 요청당 한 번이다 — 모델을 갈아타며 재시도하는 것은 우리 사정이지
  // 사용자가 더 낼 이유가 아니다. **BYOK는 애초에 차감하지 않는다.**
  let charged = false;
  if (supabase && !unlimited && !byok) {
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
   * 최종 차감 토큰 수를 돌려준다.
   *
   * **고정 차감이라(2026-09-17) 더 받거나 돌려줄 것이 없다** —
   * `figureTokenCharge()`가 원가(`estKrw`)와 무관하게 항상
   * `FIGURE_TOKEN_DEPOSIT`을 돌려주므로, 이미 건 보증금이 곧 최종 금액이다.
   * 정산 왕복(RPC 호출)이 통째로 필요 없어졌다 — 실사용량 정산이던 시절엔
   * 여기서 환불·추가 차감·미납 잠금까지 했지만 그럴 일 자체가 없다.
   */
  async function settle(estKrw: number | undefined): Promise<number | null> {
    if (!supabase || !charged) return null;
    return figureTokenCharge(estKrw);
  }

  // 생성 자체는 서버 큐의 일꾼과 같은 알맹이를 쓴다(`figureRun.ts`).
  const outcome = await runFigureGeneration({
    image,
    mode,
    korean,
    instruction,
    inputSize,
    modelIds: pickModelIds(byok, byokModel),
    byokApiKey: byokApiKey ?? undefined,
    deadlineMs: DEADLINE_MS,
    tag: "api/figure",
  });
  if (!outcome.ok) {
    await refund();
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  let persisted = false;
  if (supabase && mode === "problem" && problemId) {
    persisted =
      (await persistWholeProblem(supabase, problemId, figureId, outcome.dataUrl)) !== null;
  }
  const chargedTokens = await settle(outcome.usage?.estKrw);

  return NextResponse.json({
    image: outcome.dataUrl,
    modelId: outcome.modelId,
    persisted,
    usage: visibleUsage(outcome.usage, unlimited || byok),
    chargedTokens,
  });
}
