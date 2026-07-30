import { NextRequest, NextResponse } from "next/server";
import {
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
 * 차감 실패 사유별 사용자 메시지와 HTTP 상태.
 * 사유 문자열은 consume_diagram_credit(0010 마이그레이션)이 돌려주는 값이다.
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

type ConsumeResult = {
  ok?: boolean;
  reason?: string;
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

  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json(
      { error: "image(base64 data URL) 필드가 필요합니다." },
      { status: 400 },
    );
  }

  // 모델은 클라이언트가 고르지만, 그에 따른 과금·한도는 전적으로 DB가 정한다.
  const model: DiagramModel = isDiagramModel(body.model) ? body.model : "lite";

  if (!process.env.GEMINI_API_KEY) {
    console.error("[api/diagram] GEMINI_API_KEY not set");
    return NextResponse.json(
      { error: "GEMINI_API_KEY가 설정되지 않아 도형 재구성 기능을 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  if (isSupabaseConfigured()) {
    supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const { data, error: rpcError } = await supabase.rpc(
      "consume_diagram_credit",
      { p_model: model },
    );
    if (rpcError) {
      // 원인 파악용 — 클라이언트에도 같은 메시지를 그대로 보여준다.
      console.error("[api/diagram] consume_diagram_credit rpc error:", rpcError);
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    const result = (data ?? {}) as ConsumeResult;
    if (!result.ok) {
      const denial = DENIAL[result.reason ?? ""] ?? {
        status: 402,
        message: "도형 추가인식을 사용할 수 없습니다.",
      };
      return NextResponse.json({ error: denial.message }, { status: denial.status });
    }
  }

  /** 차감했던 1회분을 되돌린다. 실패해도 원래 오류를 덮지 않는다. */
  async function refund() {
    if (!supabase) return;
    try {
      await supabase.rpc("refund_diagram_credit", { p_model: model });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  try {
    const svg = await vectorizeDiagram(body.image, model);
    if (!svg) {
      await refund();
      return NextResponse.json(
        { error: "도형을 다시 그리지 못했습니다. 다시 시도해주세요." },
        { status: 502 },
      );
    }

    return NextResponse.json({ svg });
  } catch (err) {
    await refund();
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    console.error("[api/diagram] unexpected error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
