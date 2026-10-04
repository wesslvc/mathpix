import { NextRequest, NextResponse } from "next/server";
import { getBillingContext } from "@/lib/byok";
import { loadAsDataUrl, removeStored } from "@/lib/figureRun";
import { DIRECT_TASKS, MAX_TASK_PARAMS_CHARS, TASKS, type TaskKind } from "@/lib/aiTasks";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * **luna 작업을 곧바로 돌린다**(대기열 없이 — `aiTasks.ts` 의 `DIRECT_TASKS`). 사용자 — "luna 는 금방금방 끝나니까 서버에서
 * 돌릴 필요는 없어, 더 빠르게 할 수 있다면"(2026-10-04). 서버 대기열(`/api/figure-jobs` mode "task")과 **같은 `run`·같은 과금**
 * 이다: 보증금을 걸고(세션 차감) 돌린 뒤 실패면 돌려준다(전부 고정 요금이라 정산은 없다). 다른 점은 줄에 넣고 일꾼을 깨우고
 * 결과를 묻는 왕복이 없다는 것뿐이다. 그 대신 **이 요청이 끊기면 결과도 없다**(화면을 떠나면 사라진다) — luna 일은 짧고
 * 다시 해도 몇 원이라 그 편이 낫다.
 *
 * 그림은 본문에 데이터 URL 로 싣거나(작으면), 브라우저가 미리 `<uid>/_jobs/` 에 올린 경로로 받는다(4.5MB 한도를 넘을 때).
 */

const RUN_MS = 285_000;
const MAX_INLINE_CHARS = 4_200_000;

function ownJobPath(v: unknown, userId: string): v is string {
  return (
    typeof v === "string" &&
    v.length < 300 &&
    v.startsWith(`${userId}/_jobs/`) &&
    !v.includes("..") &&
    /^[\w./-]+$/.test(v)
  );
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "Supabase 설정이 없습니다." }, { status: 500 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  let body: { task?: unknown; images?: unknown; paths?: unknown; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const kind = DIRECT_TASKS.includes(body.task as TaskKind) ? (body.task as TaskKind) : null;
  if (!kind) return NextResponse.json({ error: "바로 돌릴 수 없는 작업이에요." }, { status: 400 });
  const def = TASKS[kind];

  const inline = Array.isArray(body.images) ? body.images : [];
  const rawPaths = Array.isArray(body.paths) ? body.paths : [];
  if (!inline.every((x) => typeof x === "string" && x.startsWith("data:image/"))) {
    return NextResponse.json({ error: "그림 형식이 올바르지 않아요." }, { status: 400 });
  }
  if ((inline as string[]).reduce((n, x) => n + x.length, 0) > MAX_INLINE_CHARS) {
    return NextResponse.json({ error: "그림이 너무 커요." }, { status: 413 });
  }
  if (!rawPaths.every((p) => ownJobPath(p, user.id))) {
    return NextResponse.json({ error: "그림 경로가 올바르지 않아요." }, { status: 400 });
  }
  const paths = rawPaths as string[];
  const count = inline.length + paths.length;
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  const admin = createAdminClient();
  const cleanup = () => (paths.length ? removeStored(admin, paths) : Promise.resolve());
  const done = async (res: NextResponse) => {
    await cleanup();
    return res;
  };
  if (count < def.images.min || count > def.images.max) {
    return done(NextResponse.json({ error: `그림 수가 맞지 않아요(${def.name}).` }, { status: 400 }));
  }
  if (JSON.stringify(params).length > MAX_TASK_PARAMS_CHARS) {
    return done(NextResponse.json({ error: "보낸 내용이 너무 길어요." }, { status: 413 }));
  }

  const billing = await getBillingContext(supabase, user.id);
  if (def.unlimitedOnly && !billing.unlimited) {
    return done(NextResponse.json({ error: "이 기능은 무제한 계정에서만 쓸 수 있습니다." }, { status: 403 }));
  }
  if (def.needsOpenAI) {
    if (billing.byok && !billing.byokApiKey) {
      return done(
        NextResponse.json(
          { error: "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요." },
          { status: 402 },
        ),
      );
    }
    if (!billing.byok && !process.env.OPENAI_API_KEY) {
      return done(NextResponse.json({ error: `OPENAI_API_KEY 가 설정되지 않아 ${def.name}을(를) 쓸 수 없습니다.` }, { status: 500 }));
    }
  }

  const loaded = await Promise.all(paths.map((p) => loadAsDataUrl(admin, p)));
  if (loaded.some((x) => !x)) {
    return done(NextResponse.json({ error: "올려 둔 그림을 찾지 못했어요. 다시 해주세요." }, { status: 400 }));
  }
  // 사진 차례: 본문에 실은 것 → 올린 것(화면이 그 차례로 나눠 보낸다 — `aiTask.ts`).
  const images = [...(inline as string[]), ...(loaded as string[])];

  const deposit = def.deposit(params);
  const charge = deposit > 0 && !billing.unlimited && !billing.byok;
  if (charge) {
    const { data, error } = await supabase.rpc("consume_recognition_credit", { p_amount: deposit });
    if (error || data === null) {
      return done(
        NextResponse.json(
          { error: error ? error.message : `토큰이 부족해요. ${def.name}에는 ${deposit}토큰이 필요합니다.` },
          { status: error ? 500 : 402 },
        ),
      );
    }
  }

  const jobId = crypto.randomUUID();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_MS);
  let out: Awaited<ReturnType<typeof def.run>>;
  try {
    out = await def.run({
      admin,
      userId: user.id,
      jobId,
      images,
      params,
      unlimited: billing.unlimited,
      byok: billing.byok,
      byokApiKey: billing.byokApiKey ?? undefined,
      signal: ctrl.signal,
      deadlineMs: RUN_MS - 10_000,
      tag: `ai-direct ${kind}`,
    });
  } catch (err) {
    out = { ok: false, error: err instanceof Error ? err.message : "알 수 없는 오류" };
  } finally {
    clearTimeout(timer);
  }
  await cleanup();

  if (!out.ok) {
    // 원가가 이미 나갔으면(읽기는 됐는데 결과를 못 씀) 보증금은 받는다 — 대기열 쪽과 같은 판단.
    const chargeAnyway = typeof out.estKrw === "number" && out.estKrw > 0;
    if (charge && !chargeAnyway) {
      await admin.rpc("refund_recognition_credit_for", { p_user_id: user.id, p_amount: deposit });
    }
    const msg = ctrl.signal.aborted ? "제때 끝나지 않았어요. 다시 해주세요." : out.error;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  return NextResponse.json({
    result: out.result,
    chargedTokens: charge ? deposit : null,
    model: out.model ?? null,
    note: out.note ?? null,
  });
}
