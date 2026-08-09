import { NextRequest, NextResponse } from "next/server";
import {
  FigureImageError,
  figureImageModelIds,
  generateFigureImage,
  type FigureSubject,
} from "@/lib/figureImageGen";
import { FIGURE_TOKEN_COST } from "@/lib/tokens";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 이미지 생성은 느리다. 기본 서버리스 제한(대개 10초대)을 넘기면 Vercel이
// JSON이 아닌 에러 페이지를 돌려줘서 클라이언트의 res.json()이 깨진다.
// (Hobby 플랜은 60초가 상한이라 더 늘릴 수 없다 — 그래서 요청 파라미터에서
// quality를 낮춰 시간을 줄인다. figureImageGen.ts의 PARAM_VARIANTS 참고.)
export const maxDuration = 60;

/**
 * 모델을 갈아타며 재시도할 최대 횟수.
 *
 * 기본 설정에서는 모델이 하나뿐이라 실제로는 한 번만 시도한다. 예전에 후보를
 * 여러 개 두고 실패하면 다음으로 내려가게 했다가, 고른 적도 없는 모델에
 * 요금이 나갔다. 폴백은 OPENAI_FIGURE_IMAGE_MODELS로 명시했을 때만 생긴다.
 */
const MAX_MODEL_ATTEMPTS = 2;

export async function POST(req: NextRequest) {
  let body: { image?: string; subject?: string };
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

  const subject: FigureSubject = body.subject === "math" ? "math" : "science";

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

  // AI 그림 생성은 실제로 돈이 나가는 유료 API라 토큰으로 과금한다.
  // 차감은 요청당 딱 한 번만 한다 —
  // 모델을 갈아타며 재시도하는 것은 우리 사정이지 사용자가 더 낼 이유가 아니다.
  let charged = false;
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc("consume_recognition_credit", {
        p_amount: FIGURE_TOKEN_COST,
      });
      if (error) throw error;
      // 함수는 남은 크레딧을 돌려주고, 부족하면 null을 준다.
      if (data === null) {
        return NextResponse.json(
          {
            error: `토큰이 부족해요. AI 그림 생성에는 ${FIGURE_TOKEN_COST}토큰이 필요합니다.`,
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
        p_amount: FIGURE_TOKEN_COST,
      });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  const modelIds = figureImageModelIds();
  let lastError: string | null = null;

  for (let i = 0; i < Math.min(modelIds.length, MAX_MODEL_ATTEMPTS); i++) {
    const modelId = modelIds[i];
    try {
      const result = await generateFigureImage(image, modelId, subject);
      if (!result) {
        await refund();
        return NextResponse.json(
          { error: "자료를 다시 그리지 못했습니다. 다시 시도해주세요." },
          { status: 502 },
        );
      }
      console.info(`[api/figure] ok model=${modelId} subject=${subject}`);
      return NextResponse.json({ image: result.dataUrl, modelId });
    } catch (err) {
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
}
