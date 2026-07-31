import { NextRequest, NextResponse } from "next/server";
import {
  DiagramApiError,
  FALLBACK_MODEL_IDS,
  isDiagramModel,
  vectorizeDiagram,
  type DiagramModel,
} from "@/lib/diagramVector";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 비전 모델은 응답 생성이 느려 기본 서버리스 함수 제한 시간(대개 10초대)을
// 넘길 수 있다. Vercel이 응답 도중 함수를 죽여버리지 않도록 여유를 둔다.
// (Hobby 플랜은 60초가 상한이라 더 늘릴 수 없다.)
export const maxDuration = 60;

/**
 * 티어를 갈아타며 재시도할 최대 횟수.
 *
 * 티어 하나가 404(없는 이름)나 429(RPD 소진)를 내면 그 모델을 오늘 소진 처리하고
 * 다음 세대로 내려가는데, 한 요청 안에서 무한정 내려가면 60초 함수 제한에 걸린다.
 * 404는 거의 즉시 떨어지므로 몇 번은 감당할 수 있지만, 실제 생성까지 간 뒤
 * 429가 나는 경우도 있어 넉넉하게 잡지 않는다.
 */
const MAX_TIER_ATTEMPTS = 3;

/**
 * 차감 실패 사유별 사용자 메시지와 HTTP 상태.
 * 사유 문자열은 consume_diagram_credit(0014 마이그레이션)이 돌려주는 값이다.
 */
const DENIAL: Record<string, { status: number; message: string }> = {
  not_paid: {
    status: 402,
    message:
      "flash(고화질) 도형 재구성은 이용권을 구매한 분만 쓸 수 있어요. lite를 선택하면 지금 바로 쓸 수 있습니다.",
  },
  no_credits: {
    status: 402,
    message:
      "사진인식권이 부족해요. lite 도형 재구성에는 5장이 필요합니다. (이용권을 구매하면 lite는 무료로 쓸 수 있어요.)",
  },
  flash_daily_exhausted: {
    status: 429,
    message:
      "오늘 쓸 수 있는 플래시쿠폰(하루 5장)을 모두 사용했어요. 내일 다시 채워지고, 그 전에 쓰시려면 lite를 선택해주세요.",
  },
};

/**
 * flash 티어를 전부 소진했을 때의 안내. 이때는 오류로 끝내지 않고 lite로
 * 갈아타 처리한다.
 */
const GLOBAL_FALLBACK_NOTICE =
  "오늘 flash(고화질) 전체 사용량이 한도에 도달해 lite로 그렸어요. 내일 다시 flash를 쓸 수 있습니다.";

type ConsumeResult = {
  ok?: boolean;
  reason?: string;
  /** 서버가 실제로 호출해야 할 Gemini 모델 이름. */
  model_id?: string;
  credits?: number;
  flash_remaining?: number;
};

export async function POST(req: NextRequest) {
  let body: { image?: string; model?: string };
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

  // 모델은 클라이언트가 고르지만, 어느 세대로 나갈지와 과금·한도는 DB가 정한다.
  const requested: DiagramModel = isDiagramModel(body.model) ? body.model : "lite";

  if (!process.env.GEMINI_API_KEY) {
    console.error("[api/diagram] GEMINI_API_KEY not set");
    return NextResponse.json(
      { error: "GEMINI_API_KEY가 설정되지 않아 도형 재구성 기능을 쓸 수 없습니다." },
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

  /** 한 모델로 1회분을 차감하고, 실제로 쓸 Gemini 모델 이름을 받아온다. */
  async function consume(m: DiagramModel): Promise<ConsumeResult> {
    if (!supabase) {
      return { ok: true, model_id: FALLBACK_MODEL_IDS[m] };
    }
    const { data, error } = await supabase.rpc("consume_diagram_credit", {
      p_model: m,
    });
    if (error) throw error;
    return (data ?? {}) as ConsumeResult;
  }

  /** 차감한 1회분을 되돌린다. modelId를 주면 그 모델의 사용량까지 되돌린다. */
  async function refund(m: DiagramModel, modelId: string | null) {
    if (!supabase) return;
    try {
      await supabase.rpc("refund_diagram_credit", {
        p_model: m,
        p_model_id: modelId,
      });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  /** 이 모델은 오늘 못 쓴다고 표시해 다음 티어로 내려가게 한다. */
  async function exhaustTier(modelId: string) {
    if (!supabase) return;
    try {
      await supabase.rpc("exhaust_diagram_model_tier", { p_model_id: modelId });
    } catch {
      // 표시에 실패해도 이번 요청은 다음 티어로 계속 진행한다.
    }
  }

  let model: DiagramModel = requested;
  let notice: string | null = null;

  for (let attempt = 0; attempt < MAX_TIER_ATTEMPTS; attempt++) {
    let result: ConsumeResult;
    try {
      result = await consume(model);

      // flash 티어를 전부 소진했다. 우리 쪽 API 한도지 사용자 잘못이 아니므로
      // 오류로 끝내지 말고 lite로 내려서 그려준다.
      if (!result.ok && result.reason === "flash_global_exhausted") {
        model = "lite";
        notice = GLOBAL_FALLBACK_NOTICE;
        result = await consume("lite");
      }
    } catch (rpcError) {
      console.error("[api/diagram] consume_diagram_credit rpc error:", rpcError);
      const message =
        rpcError instanceof Error ? rpcError.message : "크레딧 차감에 실패했습니다.";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    if (!result.ok) {
      const denial = DENIAL[result.reason ?? ""] ?? {
        status: 402,
        message: "도형 추가인식을 사용할 수 없습니다.",
      };
      return NextResponse.json({ error: denial.message }, { status: denial.status });
    }

    const modelId = result.model_id ?? FALLBACK_MODEL_IDS[model];

    try {
      const svg = await vectorizeDiagram(image, modelId);
      if (!svg) {
        await refund(model, modelId);
        return NextResponse.json(
          { error: "도형을 다시 그리지 못했습니다. 다시 시도해주세요." },
          { status: 502 },
        );
      }
      return NextResponse.json({ svg, model, modelId, notice });
    } catch (err) {
      // 404(없는 이름)나 429(RPD 소진)면 이 세대는 오늘 끝이다. 소진 처리하고
      // 다음 티어로 내려가 다시 시도한다 — 사용자에겐 오류를 보이지 않는다.
      if (err instanceof DiagramApiError && err.shouldTryNextTier) {
        console.warn(
          `[api/diagram] ${modelId} 사용 불가(${err.status}), 다음 티어로 내려감`,
        );
        await exhaustTier(modelId);
        // 개인 쿠폰/크레딧은 되돌리되(modelId를 넘기지 않아 소진 표시는 유지),
        // 다음 티어에서 다시 차감한다.
        await refund(model, null);
        notice =
          model === "flash"
            ? "고화질 모델이 오늘 한도에 걸려 다른 버전으로 그렸어요."
            : notice;
        continue;
      }

      await refund(model, modelId);
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      console.error("[api/diagram] unexpected error:", err);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  return NextResponse.json(
    {
      error:
        "쓸 수 있는 도형 재구성 모델을 찾지 못했습니다. 잠시 후 다시 시도해주세요.",
    },
    { status: 503 },
  );
}
