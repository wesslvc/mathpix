import { NextRequest, NextResponse } from "next/server";
import { GradeError, readAnswerKeyWithVision } from "@/lib/gradeExam";
import { GRADING_TOKEN_DEPOSIT, gradingEstKrw, gradingTokenCharge } from "@/lib/tokens";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 답지는 대개 한두 장이라 채점(3장)보다 가볍다. 그래도 여유를 둔다.
export const maxDuration = 90;

/**
 * 답지(정답표) 사진을 읽어 문항별 정답·배점을 돌려준다.
 *
 * **저장은 여기서 하지 않는다.** 채점(`/api/grade-exam`)과 같은 이유다 —
 * vision 이 잘못 읽는 일이 있어 사람이 검토·수정할 자리가 필요하다. 화면이
 * 표를 보여주고 사용자가 확인해야 `answer_keys` 에 저장하고 문제에 붙인다.
 *
 * 과금도 채점과 같은 모양(보증금 → 정산)이고 같은 단가를 쓴다(같은 모델이다).
 */
export async function POST(req: NextRequest) {
  let body: { images?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }

  const images = Array.isArray(body.images)
    ? body.images.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (images.length === 0) {
    return NextResponse.json({ error: "답지 사진이 필요합니다." }, { status: 400 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않아 답지 인식을 쓸 수 없습니다." },
      { status: 500 },
    );
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited")
    .eq("user_id", user.id)
    .maybeSingle();
  const unlimited = ent?.unlimited === true;

  let charged = false;
  if (!unlimited) {
    const { data, error } = await supabase.rpc("consume_recognition_credit", {
      p_amount: GRADING_TOKEN_DEPOSIT,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (data === null) {
      return NextResponse.json(
        { error: `토큰이 부족해요. 답지 인식에는 최소 ${GRADING_TOKEN_DEPOSIT}토큰이 필요합니다.` },
        { status: 402 },
      );
    }
    charged = true;
  }

  async function refund() {
    if (!charged) return;
    try {
      await supabase.rpc("refund_recognition_credit", { p_amount: GRADING_TOKEN_DEPOSIT });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  /** 보증금과 실제 값(알면)의 차이를 맞춘다(채점과 같은 방식). */
  async function settle(estKrw: number | undefined): Promise<number | null> {
    if (!charged) return null;
    const want = gradingTokenCharge(estKrw);
    const diff = want - GRADING_TOKEN_DEPOSIT;
    try {
      if (diff < 0) {
        await supabase.rpc("refund_recognition_credit", { p_amount: -diff });
      } else if (diff > 0) {
        const { data } = await supabase.rpc("consume_recognition_credit", { p_amount: diff });
        if (data === null) {
          console.warn(`[api/answer-key] ${user!.id} 잔액 부족으로 ${diff}토큰을 못 받았습니다.`);
        }
      }
    } catch (err) {
      console.error("[api/answer-key] 정산 실패:", err);
    }
    return want;
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 10) * 1000);

  try {
    const result = await readAnswerKeyWithVision(images, deadline.signal);
    // **모델을 함께 넘긴다** — 단가가 모델마다 열 배까지 다르다.
    const estKrw = result.usage ? gradingEstKrw(result.usage, result.model) : undefined;
    const chargedTokens = await settle(estKrw);

    // 금액은 무제한 계정에만 보여준다(막는 자리는 서버 — 화면 숨김은 우회 가능).
    const usage = unlimited && result.usage ? { ...result.usage, estKrw } : undefined;

    return NextResponse.json({
      items: result.items,
      usage,
      chargedTokens,
      model: result.model,
    });
  } catch (err) {
    if (deadline.signal.aborted) {
      await refund();
      return NextResponse.json(
        { error: `답지 인식이 ${maxDuration}초 안에 끝나지 않았습니다. 토큰은 돌려드렸어요.` },
        { status: 504 },
      );
    }
    await refund();
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "답지 인식에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
