import { NextRequest, NextResponse } from "next/server";
import { GradeError, readKoreanTitle } from "@/lib/gradeExam";
import { gradingEstKrw } from "@/lib/tokens";
import { startGradingBilling } from "@/lib/gradingBilling";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 글자만 보내므로 사진을 보내는 채점보다 훨씬 가볍다.
export const maxDuration = 60;

/** 보내는 글자 수 상한. 지문 한 편은 넉넉히 들어가고, 통째로 보내는 사고는 막는다. */
const MAX_CHARS = 12000;

/** 이 일에 걸어 두는 보증금. 글자만 보내는 호출이라 아주 싸다. */
const DEPOSIT = 1;

/**
 * 국어 지문 제목 짓기.
 *
 * Mathpix 가 읽어 둔 **글자만** 보낸다 — 사진을 다시 보내면 입력 그림 토큰이
 * 붙어 값이 몇 배가 된다. 제목은 첫 장 목차와 지문 카드에 쓰인다.
 *
 * 과금은 다른 vision 라우트와 같은 모양(보증금 → 실사용량 정산)이고
 * `gradingBilling.ts` 한 곳을 쓴다.
 */
export async function POST(req: NextRequest) {
  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_CHARS) : "";
  if (text.length < 20) {
    return NextResponse.json(
      { error: "제목을 지을 만큼 글자가 인식되지 않았습니다." },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않아 제목 짓기를 쓸 수 없습니다." },
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

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited,
      deposit: DEPOSIT,
      label: "api/korean-title",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "과금 처리에 실패했습니다." },
      { status: 500 },
    );
  }
  if (!billing) {
    return NextResponse.json(
      { error: `토큰이 부족해요. 제목 짓기에는 ${DEPOSIT}토큰이 필요합니다.` },
      { status: 402 },
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 10) * 1000);
  try {
    const { result, usage, model } = await readKoreanTitle(text, deadline.signal);
    const estKrw = usage ? gradingEstKrw(usage) : undefined;
    const chargedTokens = await billing.settle(estKrw);

    // 지문 인식(`/api/korean-text`)과 **같은 모양으로** 찍는다. 사용자가
    // 견준 것이 바로 이 둘("루나는 제목 하나에 몇천 토큰, 테라는 천 토큰
    // 초반")이라, 둘이 같은 형식으로 남아야 로그에서 바로 견줄 수 있다.
    // 이쪽은 **사진을 안 보내고 글자만** 보낸다는 게 핵심 차이다.
    console.info(
      `[korean-title] usage model=${model} 입력글=${text.length}자(사진 없음) ` +
        `in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} ` +
        `est=${estKrw != null ? `${Math.round(estKrw)}원` : "단가미설정"} ` +
        `차감=${chargedTokens}토큰`,
    );
    return NextResponse.json({
      ...result,
      // 금액은 무제한 계정에만 보여준다(막는 자리는 서버다).
      usage: unlimited && usage ? { ...usage, estKrw } : undefined,
      chargedTokens,
      model,
    });
  } catch (err) {
    await billing.refund();
    if (deadline.signal.aborted) {
      return NextResponse.json(
        { error: "제목 짓기가 제때 끝나지 않았습니다. 토큰은 돌려드렸어요." },
        { status: 504 },
      );
    }
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "제목 짓기에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
