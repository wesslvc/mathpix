import { NextRequest, NextResponse } from "next/server";
import { GradeError, readKoreanTitle } from "@/lib/gradeExam";
import { gradingEstKrw } from "@/lib/tokens";
import { startGradingBilling } from "@/lib/gradingBilling";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getBillingContext } from "@/lib/byok";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// luna 에 사진 한 장(또는 글자)만 보내는 가벼운 호출이다.
export const maxDuration = 60;

/** 보내는 글자 수 상한. 지문 한 편은 넉넉히 들어가고, 통째로 보내는 사고는 막는다. */
const MAX_CHARS = 12000;

/** 이 일에 물릴 **고정** 차감액. luna 라 원가가 아주 싸다(2026-09-26, 무료 회원도
 *  실컷 쓸 수 있게 실사용량 정산이 아니라 늘 이만큼만 뗀다 — `flat: true`). */
const DEPOSIT = 1;

/**
 * 국어 지문 제목 짓기.
 *
 * 지문 **사진**(`image`)을 받는다. 예전에는 따로 읽어 둔 글자(`text`)만 받았는데
 * 지문 인식이 한 번의 호출로 합쳐지면서(2026-09-25) 글자를 먼저 읽는 단계가
 * 없어졌다. 글자를 넘기면 예전처럼 글만 보낸다. 제목은 첫 장 목차와 지문 카드에 쓰인다.
 *
 * 과금은 `gradingBilling.ts` 한 곳을 쓰고 `flat: true`로 늘 `DEPOSIT`만 뗀다.
 */
export async function POST(req: NextRequest) {
  let body: { text?: unknown; image?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_CHARS) : "";
  const image =
    typeof body.image === "string" && body.image.startsWith("data:image/") ? body.image : "";
  if (!image && text.length < 20) {
    return NextResponse.json(
      { error: "제목을 지을 지문 사진이나 글이 필요합니다." },
      { status: 400 },
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
      { error: "OPENAI_API_KEY가 설정되지 않아 제목 짓기를 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited,
      byok,
      deposit: DEPOSIT,
      flat: true,
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
    const { result, usage, model } = await readKoreanTitle(
      text.length >= 20 ? { text } : { image },
      deadline.signal,
      byokApiKey ?? undefined,
    );
    // **모델을 함께 넘긴다** — 단가가 모델마다 열 배까지 다르다.
    const estKrw = usage ? gradingEstKrw(usage, model) : undefined;
    const chargedTokens = await billing.settle(estKrw);

    // 지문 인식(`/api/korean-text`)과 **같은 모양으로** 찍는다. 사용자가
    // 견준 것이 바로 이 둘("루나는 제목 하나에 몇천 토큰, 테라는 천 토큰
    // 초반")이라, 둘이 같은 형식으로 남아야 로그에서 바로 견줄 수 있다.
    console.info(
      `[korean-title] usage model=${model} ` +
        (text.length >= 20 ? `입력글=${text.length}자 ` : "입력=사진 ") +
        `in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} ` +
        `est=${estKrw != null ? `${Math.round(estKrw)}원` : "단가미설정"} ` +
        `차감=${chargedTokens}토큰`,
    );
    return NextResponse.json({
      ...result,
      // 금액은 무제한·BYOK 계정에만 보여준다(막는 자리는 서버다).
      usage: (unlimited || byok) && usage ? { ...usage, estKrw } : undefined,
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
