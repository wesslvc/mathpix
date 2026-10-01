import { NextRequest, NextResponse } from "next/server";
import { getBillingContext } from "@/lib/byok";
import { startGradingBilling } from "@/lib/gradingBilling";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { logAiCost, solTokens } from "@/lib/costLog";
import { askSol, loadPatchImages } from "@/lib/problemLoopRun";
import { parseSolChat, planToChanges, solChatPrompt, type ChatTurn } from "@/lib/problemCompare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 한 번의 대화에서 오갈 수 있는 말 수(사용자 + sol). 끝없이 늘어 요금이 커지는 것을 막는다. */
const MAX_MESSAGES = 24;
/** 한 마디를 물릴 보증금. 끝나면 실제 사용량으로 정산한다(무제한·BYOK 는 안 받는다). */
const TURN_DEPOSIT = 20;
const MAX_IMAGE_CHARS = 3_000_000;

/**
 * **수정 대화**(`SolChat`). sol 이 원본과 지금 그림을 보며 사용자와 주고받고, 합의한 수정 사항(`plan`)을 매번 돌려준다.
 * **추론 강도는 설정하지 않는다**(사용자 지시 — "추론강도는 설정하지 않은 채로 대화하고") — 강도 값을 아예 안 보낸다.
 *
 * 그림은 둘 중 하나로 준다: `jobId`(서버 작업 — 원본과 지금 저장된 그림을 서버가 읽는다) 또는 `images`(수정 창처럼 화면이
 * 가진 그림 두 장, 데이터 URL). 응답은 `{ reply, plan? }` — `plan.text` 가 그림 모델에 갈 지시다.
 */
export async function POST(req: NextRequest) {
  let body: { goal?: unknown; jobId?: unknown; images?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const goal = body.goal === "redraw" ? "redraw" : "patch";
  const turns: ChatTurn[] = (Array.isArray(body.messages) ? body.messages : [])
    .map((m) => {
      const r = m as { role?: unknown; text?: unknown };
      return { role: r.role === "assistant" ? "assistant" : "user", text: typeof r.text === "string" ? r.text : "" } as ChatTurn;
    })
    .filter((t) => t.text.trim());
  if (turns.length === 0 || turns[turns.length - 1].role !== "user") {
    return NextResponse.json({ error: "보낼 말이 없어요." }, { status: 400 });
  }
  if (turns.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "대화가 너무 길어졌어요. 지금까지 정리된 수정 사항으로 확정하거나 새로 시작해주세요." }, { status: 400 });
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
    return NextResponse.json({ error: "OPENAI_API_KEY가 설정되지 않아 대화를 쓸 수 없습니다." }, { status: 500 });
  }

  const admin = createAdminClient();
  let images: string[] = [];
  let findings = "";
  let jobId: string | null = null;
  if (typeof body.jobId === "string") {
    const { data: row } = await admin
      .from("figure_jobs")
      .select("id, input_path, state")
      .eq("id", body.jobId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "작업을 찾지 못했어요." }, { status: 404 });
    const loaded = await loadPatchImages(admin, row);
    if (!loaded) return NextResponse.json({ error: "원본이나 지금 그림을 찾지 못했어요." }, { status: 404 });
    images = [loaded.original, loaded.current];
    findings = loaded.findings;
    jobId = row.id;
  } else {
    const list = Array.isArray(body.images) ? body.images : [];
    images = list.filter((x): x is string => typeof x === "string" && x.startsWith("data:image/") && x.length <= MAX_IMAGE_CHARS).slice(0, 2);
    if (images.length !== 2 || images.length !== list.length) {
      return NextResponse.json({ error: "원본과 지금 그림, 두 장이 필요해요." }, { status: 400 });
    }
  }

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited: billingCtx.unlimited,
      byok: billingCtx.byok,
      deposit: TURN_DEPOSIT,
      label: "sol-chat",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "토큰을 확인하지 못했어요." }, { status: 500 });
  }
  if (!billing) {
    return NextResponse.json({ error: `토큰이 부족해요. 대화 한 마디에 최대 ${TURN_DEPOSIT}토큰이 필요합니다(끝나면 쓴 만큼만 받아요).` }, { status: 402 });
  }

  const prompt = solChatPrompt(goal, turns, findings);
  const ask = await askSol(
    prompt.head,
    images,
    { byokApiKey: billingCtx.byokApiKey ?? undefined, modelIds: [], deadlineMs: 100_000, tag: "sol-chat" },
    "대화",
    // 대화 내용은 사진 뒤에 — 지시문 + 사진 두 장이 마디마다 캐시에 맞는다.
    { noEffort: true, cacheKey: "reprint-sol-chat", tail: prompt.tail },
  );
  if (ask.krw > 0 && !billingCtx.byok) {
    await logAiCost(admin, { userId: user.id, jobId, kind: "problem", what: "sol 수정 대화", krw: ask.krw, tokens: solTokens(ask.usage) });
  }
  if (ask.text === null) {
    await billing.refund();
    return NextResponse.json({ error: `sol 이 답하지 못했어요. ${ask.fail.slice(0, 160)}` }, { status: 502 });
  }
  let parsed;
  try {
    parsed = parseSolChat(ask.text);
  } catch (err) {
    await billing.settle(ask.krw > 0 ? ask.krw : undefined);
    return NextResponse.json({ error: err instanceof Error ? err.message : "sol 답변을 읽지 못했어요." }, { status: 502 });
  }
  const charged = await billing.settle(ask.krw > 0 ? ask.krw : undefined);
  return NextResponse.json({
    reply: parsed.reply,
    plan: parsed.plan
      ? { understood: parsed.plan.understood, text: planToChanges(parsed.plan), count: parsed.plan.edits.length }
      : null,
    chargedTokens: charged,
    // 원가는 무제한·BYOK 계정에만 보여 준다.
    ...(billingCtx.unlimited || billingCtx.byok ? { estKrw: Math.round(ask.krw * 10) / 10 } : {}),
  });
}
