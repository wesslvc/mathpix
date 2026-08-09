import { NextRequest, NextResponse } from "next/server";
import {
  FigureApiError,
  figureModelIds,
  vectorizeFigure,
} from "@/lib/figureVector";
import { FIGURE_CREDIT_COST } from "@/lib/figureCost";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 비전 모델은 응답 생성이 느려 기본 서버리스 제한(대개 10초대)을 넘긴다.
// 넘기면 Vercel이 JSON이 아닌 에러 페이지를 돌려줘서 클라이언트의 res.json()이
// 깨진다. (Hobby 플랜은 60초가 상한이라 더 늘릴 수 없다.)
export const maxDuration = 60;

/**
 * 모델을 갈아타며 재시도할 최대 횟수.
 * 404/403은 즉시 떨어지지만, 실제 생성까지 갔다가 429가 나는 경우도 있어서
 * 60초 안에 끝나도록 넉넉하게 잡지 않는다.
 */
const MAX_MODEL_ATTEMPTS = 3;

export async function POST(req: NextRequest) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "잘못된 요청 본문입니다." },
      { status: 400 },
    );
  }

  const image = body.image;
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
  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }
  }

  // 자료 재구성은 실제로 돈이 나가는 유료 API라 사진인식권으로 과금한다.
  // 수학 도형(도형 추가인식)과 같은 크레딧 통을 쓰되, 여기서는 모델 티어별
  // 하루 예산 같은 게 없어서 차감은 딱 한 번만 한다 — 모델을 갈아타며
  // 재시도하는 것은 우리 사정이지 사용자가 더 낼 이유가 아니다.
  let charged = false;
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc("consume_recognition_credit", {
        p_amount: FIGURE_CREDIT_COST,
      });
      if (error) throw error;
      // 함수는 남은 크레딧을 돌려주고, 부족하면 null을 준다.
      if (data === null) {
        return NextResponse.json(
          {
            error: `사진인식권이 부족해요. 자료 재구성에는 ${FIGURE_CREDIT_COST}장이 필요합니다.`,
          },
          { status: 402 },
        );
      }
      charged = true;
    } catch (rpcError) {
      console.error("[api/figure] consume_recognition_credit rpc error:", rpcError);
      const message =
        rpcError instanceof Error ? rpcError.message : "크레딧 차감에 실패했습니다.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  async function refund() {
    if (!supabase || !charged) return;
    try {
      await supabase.rpc("refund_recognition_credit", {
        p_amount: FIGURE_CREDIT_COST,
      });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  const modelIds = figureModelIds();
  let lastError: string | null = null;

  for (let i = 0; i < Math.min(modelIds.length, MAX_MODEL_ATTEMPTS); i++) {
    const modelId = modelIds[i];
    try {
      const result = await vectorizeFigure(image, modelId);
      if (!result) {
        await refund();
        return NextResponse.json(
          { error: "자료를 다시 그리지 못했습니다. 다시 시도해주세요." },
          { status: 502 },
        );
      }
      // 비용은 거의 전부 출력 토큰에서 나온다. 어느 자료가 비쌌는지 알 수 있게
      // 남겨둔다(사용자 화면이 아니라 서버 로그).
      console.info(
        `[api/figure] ok model=${modelId} in=${result.inputTokens} out=${result.outputTokens}`,
      );
      return NextResponse.json({
        svg: result.svg,
        modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
    } catch (err) {
      // 404(없는 이름)/403(권한 없음)/429(한도)면 이 모델로는 안 된다.
      // 다음 후보로 내려가 재시도한다 — 사용자에겐 오류를 보이지 않는다.
      if (err instanceof FigureApiError && err.shouldTryNextModel) {
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

  // 후보를 다 써도 못 불렀다. 이름이 틀렸을 가능성이 높으니 확인 방법을 알려준다.
  await refund();
  console.error(
    `[api/figure] 쓸 수 있는 모델을 찾지 못함. 후보=${modelIds.join(", ")}`,
  );
  return NextResponse.json(
    {
      error:
        "쓸 수 있는 자료 재구성 모델을 찾지 못했습니다. 관리자는 /api/figure/models 에서 이 키로 부를 수 있는 모델을 확인하고 OPENAI_FIGURE_MODELS 환경변수에 넣어주세요." +
        (lastError ? ` (마지막 오류: ${lastError})` : ""),
    },
    { status: 503 },
  );
}
