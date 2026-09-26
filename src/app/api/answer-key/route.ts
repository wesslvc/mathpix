import { NextRequest, NextResponse } from "next/server";
import { GradeError, readAnswerKeyWithVision } from "@/lib/gradeExam";
import { gradingEstKrw } from "@/lib/tokens";
import { startGradingBilling } from "@/lib/gradingBilling";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getBillingContext } from "@/lib/byok";

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
 * **과금은 고정 1토큰**(채점과 같은 이유·같은 시점, 2026-09-26 — 위
 * `/api/grade-exam` 주석 참고). `gradingBilling.ts`의 `flat: true`를 쓴다.
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
  const { unlimited, byok, byokApiKey } = await getBillingContext(supabase, user.id);

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
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않아 답지 인식을 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited,
      byok,
      flat: true,
      label: "api/answer-key",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "과금 처리에 실패했습니다." },
      { status: 500 },
    );
  }
  if (!billing) {
    return NextResponse.json(
      { error: "토큰이 부족해요. 답지 인식에는 토큰이 필요합니다." },
      { status: 402 },
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 10) * 1000);

  try {
    const result = await readAnswerKeyWithVision(images, deadline.signal, byokApiKey ?? undefined);
    // **모델을 함께 넘긴다** — 단가가 모델마다 열 배까지 다르다.
    const estKrw = result.usage ? gradingEstKrw(result.usage, result.model) : undefined;
    const chargedTokens = await billing.settle(estKrw);

    // 금액은 무제한·BYOK 계정에만 보여준다(막는 자리는 서버 — 화면 숨김은 우회 가능).
    const usage =
      (unlimited || byok) && result.usage ? { ...result.usage, estKrw } : undefined;

    return NextResponse.json({
      items: result.items,
      usage,
      chargedTokens,
      model: result.model,
    });
  } catch (err) {
    if (deadline.signal.aborted) {
      await billing.refund();
      return NextResponse.json(
        { error: `답지 인식이 ${maxDuration}초 안에 끝나지 않았습니다. 토큰은 돌려드렸어요.` },
        { status: 504 },
      );
    }
    await billing.refund();
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "답지 인식에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
