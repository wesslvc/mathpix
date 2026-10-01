import { NextRequest, NextResponse } from "next/server";
import { getBillingContext } from "@/lib/byok";
import { logAiCost, solTokens } from "@/lib/costLog";
import { OPENAI_TEXT_EFFORT } from "@/lib/gradeExam";
import { startGradingBilling } from "@/lib/gradingBilling";
import { parseTranscription, TYPESET_PROMPT } from "@/lib/problemCompare";
import { askSol } from "@/lib/problemLoopRun";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 보증금. 끝나면 실제 사용량으로 정산한다(무제한·BYOK 는 안 받는다) — 서식 검수와 같은 값이다. */
const DEPOSIT = 30;
const MAX_IMAGE_CHARS = 4_000_000;

/**
 * **sol 이 문제를 글자로 옮겨 적는다**(수정 창의 "sol 인식 후 조판"). 사진 한 장을 받아 `{ text, figures }` 를 돌려준다 —
 * `text` 는 우리 인식 경로가 그리는 꼴(`renderMathText`)이고, `figures` 는 글자로 못 옮긴 그림의 자리(사진 대비 비율)다.
 * 조판(카드 조립)과 그림 오려 붙이기는 화면이 한다 — 원본 사진을 들고 있는 것도, 카드를 그리는 것도 화면이다.
 *
 * 강도는 지문 인식과 같은 `OPENAI_TEXT_EFFORT`(기본 medium). 캐시 키는 `reprint-typeset`(지시문이 늘 같다).
 */
export async function POST(req: NextRequest) {
  let body: { image?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image.startsWith("data:image/") || image.length > MAX_IMAGE_CHARS) {
    return NextResponse.json({ error: "문제 사진이 필요해요." }, { status: 400 });
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const billingCtx = await getBillingContext(supabase, user.id);
  if (billingCtx.byok && !billingCtx.byokApiKey) {
    return NextResponse.json(
      { error: "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요." },
      { status: 402 },
    );
  }
  if (!billingCtx.byok && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY가 설정되지 않아 쓸 수 없습니다." }, { status: 500 });
  }

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited: billingCtx.unlimited,
      byok: billingCtx.byok,
      deposit: DEPOSIT,
      label: "sol-typeset",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "토큰을 확인하지 못했어요." }, { status: 500 });
  }
  if (!billing) {
    return NextResponse.json({ error: `토큰이 부족해요. 최대 ${DEPOSIT}토큰이 필요합니다(끝나면 쓴 만큼만 받아요).` }, { status: 402 });
  }

  const ask = await askSol(
    TYPESET_PROMPT,
    [image],
    { byokApiKey: billingCtx.byokApiKey ?? undefined, modelIds: [], deadlineMs: 270_000, tag: "sol-typeset" },
    "조판 인식",
    { cacheKey: "reprint-typeset", effort: OPENAI_TEXT_EFFORT },
  );
  if (ask.krw > 0 && !billingCtx.byok) {
    await logAiCost(createAdminClient(), {
      userId: user.id,
      jobId: null,
      kind: "problem",
      what: "sol 조판 인식",
      krw: ask.krw,
      tokens: solTokens(ask.usage),
    });
  }
  if (ask.text === null) {
    await billing.refund();
    return NextResponse.json({ error: `sol 이 읽지 못했어요. ${ask.fail.slice(0, 160)}` }, { status: 502 });
  }
  let parsed;
  try {
    parsed = parseTranscription(ask.text);
  } catch (err) {
    // 읽기는 했으니(원가가 나갔다) 쓴 만큼은 받는다.
    await billing.settle(ask.krw > 0 ? ask.krw : undefined);
    return NextResponse.json({ error: err instanceof Error ? err.message : "sol 결과를 읽지 못했어요." }, { status: 502 });
  }
  const charged = await billing.settle(ask.krw > 0 ? ask.krw : undefined);
  return NextResponse.json({
    text: parsed.text,
    figures: parsed.figures,
    chargedTokens: charged,
    ...(billingCtx.unlimited || billingCtx.byok ? { estKrw: Math.round(ask.krw * 10) / 10 } : {}),
  });
}
