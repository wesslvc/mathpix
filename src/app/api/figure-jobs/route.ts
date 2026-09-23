import { NextRequest, NextResponse } from "next/server";
import { redirectBase } from "@/app/auth/redirectBase";
import { getBillingContext } from "@/lib/byok";
import { FIGURE_TOKEN_DEPOSIT } from "@/lib/tokens";
import { removeStored, splitDataUrl, storeBytes } from "@/lib/figureRun";
import { JOB_COLUMNS, kickWorker, type FigureJobRow } from "@/lib/figureJobsServer";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * AI 그림 작업을 **서버 큐에** 넣고 · 보고 · 고치고 · 치운다.
 *
 * 예전에는 큐가 브라우저 안에 있어서 탭을 닫으면 줄이 통째로 사라졌다. 이제
 * 브라우저는 여기로 넣기만 하고, 실제 생성은 일꾼(`/api/figure-jobs/run`)이 한다.
 * 쓰기는 전부 서비스 키로 한다(과금과 얽혀 있어 표를 화면에 열어 두지 않는다) —
 * 그래서 **여기서 본인 것인지 반드시 확인한다.** RLS 가 대신 막아 주지 않는다.
 */

/** Vercel 요청 본문 한도(4.5MB) 안쪽. 화면이 이미 줄여서 보내므로 넉넉하다. */
const MAX_IMAGE_CHARS = 4_200_000;

async function sessionUser() {
  if (!isSupabaseConfigured()) return { supabase: null, user: null };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** 지금 보여줄 작업들. 치운 것과 이틀 넘은 것은 뺀다. */
export async function GET() {
  const { supabase, user } = await sessionUser();
  if (!supabase || !user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  // 읽기는 RLS(본인 것만)로 충분하다.
  const { data, error } = await supabase
    .from("figure_jobs")
    .select(JOB_COLUMNS)
    .eq("dismissed", false)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: NextRequest) {
  let body: {
    figureId?: string;
    problemKey?: string;
    label?: string;
    image?: string;
    mode?: string;
    korean?: boolean;
    instruction?: string;
    problemId?: string | null;
    width?: number;
    height?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }

  const { supabase, user } = await sessionUser();
  if (!supabase || !user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const figureId = typeof body.figureId === "string" ? body.figureId.slice(0, 100) : "";
  const image = typeof body.image === "string" ? body.image : "";
  if (!figureId || !image || image.length > MAX_IMAGE_CHARS) {
    return NextResponse.json({ error: "그림을 받지 못했어요." }, { status: 400 });
  }
  const parts = splitDataUrl(image);
  if (!parts) {
    return NextResponse.json({ error: "그림 형식이 올바르지 않아요." }, { status: 400 });
  }

  // 문제 행이 본인 것인지 본다(RLS 가 걸린 세션 클라이언트로 읽는다).
  let problemId: string | null = null;
  if (typeof body.problemId === "string" && body.problemId) {
    const { data } = await supabase
      .from("problems")
      .select("id")
      .eq("id", body.problemId)
      .maybeSingle();
    problemId = data?.id ?? null;
  }

  const billing = await getBillingContext(supabase, user.id);
  if (billing.byok && !billing.byokApiKey) {
    return NextResponse.json(
      {
        error:
          "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요.",
      },
      { status: 402 },
    );
  }
  if (!billing.byok && !process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않아 AI 그림 생성을 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  const admin = createAdminClient();

  // **같은 그림이 이미 줄에 있으면 그걸 돌려준다** — 작업 하나가 곧 유료 호출
  // 한 번이라 두 번 들어가면 토큰이 두 배로 빠진다.
  const existing = await admin
    .from("figure_jobs")
    .select(JOB_COLUMNS)
    .eq("user_id", user.id)
    .eq("figure_id", figureId)
    .in("status", ["pending", "running"])
    .eq("dismissed", false)
    .maybeSingle();
  if (existing.data) return NextResponse.json({ job: existing.data });

  const jobId = crypto.randomUUID();
  const inputPath = `${user.id}/_jobs/${jobId}-in.${parts.ext}`;
  if (!(await storeBytes(supabase, inputPath, parts.bytes, parts.mime))) {
    return NextResponse.json({ error: "그림을 올리지 못했어요." }, { status: 502 });
  }

  const mode = body.mode === "problem" ? "problem" : "figure";
  const inserted = await admin
    .from("figure_jobs")
    .insert({
      id: jobId,
      user_id: user.id,
      figure_id: figureId,
      problem_key: typeof body.problemKey === "string" ? body.problemKey.slice(0, 200) : "",
      problem_id: problemId,
      label: typeof body.label === "string" ? body.label.slice(0, 100) : "",
      mode,
      korean: body.korean === true,
      instruction:
        typeof body.instruction === "string"
          ? body.instruction.slice(0, 500).trim() || null
          : null,
      input_path: inputPath,
      width: typeof body.width === "number" && body.width > 0 ? Math.round(body.width) : null,
      height:
        typeof body.height === "number" && body.height > 0 ? Math.round(body.height) : null,
    })
    .select(JOB_COLUMNS)
    .single<FigureJobRow>();

  if (inserted.error || !inserted.data) {
    await removeStored(admin, [inputPath]);
    // 동시에 두 번 들어와 한쪽이 먼저 넣은 경우(고유 인덱스).
    if (inserted.error?.code === "23505") {
      const again = await admin
        .from("figure_jobs")
        .select(JOB_COLUMNS)
        .eq("user_id", user.id)
        .eq("figure_id", figureId)
        .in("status", ["pending", "running"])
        .eq("dismissed", false)
        .maybeSingle();
      if (again.data) return NextResponse.json({ job: again.data });
    }
    return NextResponse.json(
      { error: inserted.error?.message ?? "작업을 넣지 못했어요." },
      { status: 500 },
    );
  }

  // **보증금은 넣을 때 건다.** 잔액이 모자라면 줄에 서기 전에 바로 알려 줄 수
  // 있고, 일꾼은 세션 없이 도는데 기존 차감 함수는 세션(auth.uid())을 요구한다.
  // 실패하면 일꾼이(또는 멈춘 작업 정리가) 이만큼 돌려준다.
  let job = inserted.data;
  if (!billing.unlimited && !billing.byok) {
    const { data, error } = await supabase.rpc("consume_recognition_credit", {
      p_amount: FIGURE_TOKEN_DEPOSIT,
    });
    if (error || data === null) {
      await admin.from("figure_jobs").delete().eq("id", jobId);
      await removeStored(admin, [inputPath]);
      return NextResponse.json(
        {
          error: error
            ? error.message
            : `토큰이 부족해요. AI 그림 생성에는 최소 ${FIGURE_TOKEN_DEPOSIT}토큰이 필요합니다.`,
        },
        { status: error ? 500 : 402 },
      );
    }
    const charged = await admin
      .from("figure_jobs")
      .update({ charged: true, charged_tokens: FIGURE_TOKEN_DEPOSIT })
      .eq("id", jobId)
      .select(JOB_COLUMNS)
      .single<FigureJobRow>();
    if (charged.data) job = charged.data;
  }

  await kickWorker(admin, redirectBase(req), user.id);
  return NextResponse.json({ job });
}

/**
 * 작업 하나를 고친다.
 *  - `setProblem`   : 넣을 때 아직 저장 전이던 문제 행을 알려 준다.
 *  - `retry`        : 실패한 것을 다시 줄에 세운다(보증금을 다시 건다).
 *  - `claimApply`   : 그림 하나 모드의 결과를 카드에 반영하겠다고 찜한다.
 *                     기기 둘이 동시에 열려 있어도 한쪽만 반영한다.
 *  - `releaseApply` : 반영에 실패해 찜을 푼다.
 */
export async function PATCH(req: NextRequest) {
  let body: { id?: string; action?: string; problemId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const { supabase, user } = await sessionUser();
  if (!supabase || !user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (typeof body.id !== "string") {
    return NextResponse.json({ error: "id 가 필요합니다." }, { status: 400 });
  }
  const admin = createAdminClient();

  if (body.action === "setProblem") {
    if (typeof body.problemId !== "string") {
      return NextResponse.json({ error: "problemId 가 필요합니다." }, { status: 400 });
    }
    const { data: p } = await supabase
      .from("problems")
      .select("id")
      .eq("id", body.problemId)
      .maybeSingle();
    if (!p) return NextResponse.json({ error: "문제를 찾지 못했어요." }, { status: 404 });
    const { data } = await admin
      .from("figure_jobs")
      .update({ problem_id: p.id })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .is("problem_id", null)
      .select(JOB_COLUMNS)
      .maybeSingle();
    await kickWorker(admin, redirectBase(req), user.id);
    return NextResponse.json({ job: data });
  }

  if (body.action === "claimApply" || body.action === "releaseApply") {
    const claim = body.action === "claimApply";
    let q = admin
      .from("figure_jobs")
      .update({ applied_at: claim ? new Date().toISOString() : null })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .eq("status", "done");
    q = claim ? q.is("applied_at", null) : q;
    const { data } = await q.select(JOB_COLUMNS).maybeSingle();
    return NextResponse.json({ job: data, claimed: claim ? !!data : undefined });
  }

  if (body.action === "retry") {
    const { data: row } = await admin
      .from("figure_jobs")
      .select("id, status, charged")
      .eq("id", body.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "작업을 찾지 못했어요." }, { status: 404 });
    if (row.status !== "error") {
      return NextResponse.json({ error: "실패한 작업만 다시 돌릴 수 있어요." }, { status: 409 });
    }
    const billing = await getBillingContext(supabase, user.id);
    const patch: Record<string, unknown> = {
      status: "pending",
      error: null,
      finished_at: null,
      started_at: null,
    };
    if (!billing.unlimited && !billing.byok && !row.charged) {
      const { data, error } = await supabase.rpc("consume_recognition_credit", {
        p_amount: FIGURE_TOKEN_DEPOSIT,
      });
      if (error || data === null) {
        return NextResponse.json(
          {
            error: error
              ? error.message
              : `토큰이 부족해요. AI 그림 생성에는 최소 ${FIGURE_TOKEN_DEPOSIT}토큰이 필요합니다.`,
          },
          { status: error ? 500 : 402 },
        );
      }
      patch.charged = true;
      patch.charged_tokens = FIGURE_TOKEN_DEPOSIT;
    }
    const { data, error } = await admin
      .from("figure_jobs")
      .update(patch)
      .eq("id", body.id)
      .eq("user_id", user.id)
      .eq("status", "error")
      .select(JOB_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      // 같은 그림이 이미 다시 줄에 서 있다(고유 인덱스) — 방금 건 보증금은 돌려준다.
      if (patch.charged) {
        await admin.rpc("refund_recognition_credit_for", {
          p_user_id: user.id,
          p_amount: FIGURE_TOKEN_DEPOSIT,
        });
      }
      return NextResponse.json(
        { error: "이미 같은 그림이 줄에 있어요." },
        { status: 409 },
      );
    }
    await kickWorker(admin, redirectBase(req), user.id);
    return NextResponse.json({ job: data });
  }

  return NextResponse.json({ error: "알 수 없는 동작입니다." }, { status: 400 });
}

/**
 * 목록에서 치운다.
 *  - 아직 안 시작한 것: 줄에서 빼고 **보증금을 돌려준다.**
 *  - 도는 중인 것: 멈출 수 없어 숨기기만 한다(결과는 그대로 저장된다).
 *  - 끝난 것: 기록을 지운다.
 */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const { supabase, user } = await sessionUser();
  if (!supabase || !user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (!id) return NextResponse.json({ error: "id 가 필요합니다." }, { status: 400 });
  const admin = createAdminClient();

  // 안 시작한 것은 지우면서 그 자리에서 보증금 액수를 받아 온다. 조건에
  // status=pending 을 걸어서, 그 사이 일꾼이 집어 갔으면 아무것도 안 지워진다.
  const { data: removed } = await admin
    .from("figure_jobs")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "pending")
    .select("input_path, charged, charged_tokens")
    .maybeSingle();
  if (removed) {
    if (removed.charged && removed.charged_tokens > 0) {
      await admin.rpc("refund_recognition_credit_for", {
        p_user_id: user.id,
        p_amount: removed.charged_tokens,
      });
    }
    await removeStored(admin, [removed.input_path]);
    return NextResponse.json({ ok: true, refunded: removed.charged });
  }

  const { data: running } = await admin
    .from("figure_jobs")
    .update({ dismissed: true })
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (running) return NextResponse.json({ ok: true });

  const { data: finished } = await admin
    .from("figure_jobs")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .in("status", ["done", "error"])
    .select("status, input_path")
    .maybeSingle();
  // 실패한 작업은 다시 시도하려고 입력을 남겨 뒀다 — 치웠으니 지운다.
  if (finished?.status === "error") await removeStored(admin, [finished.input_path]);
  return NextResponse.json({ ok: true });
}
