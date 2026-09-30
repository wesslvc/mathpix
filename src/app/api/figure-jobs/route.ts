import { NextRequest, NextResponse } from "next/server";
import { redirectBase } from "@/app/auth/redirectBase";
import { getBillingContext } from "@/lib/byok";
import { FIGURE_TOKEN_DEPOSIT, MAX_REDRAW_TOKENS, PATCH_REDRAW_TOKENS } from "@/lib/tokens";
import { removeStored, splitDataUrl, storeBytes } from "@/lib/figureRun";
import { JOB_COLUMNS, UNLIMITED_CONCURRENCY, kickWorker, type FigureJobRow } from "@/lib/figureJobsServer";
import { passageDepositFrom, passageInputPaths, type PassagePayload } from "@/lib/passageRun";
import {
  PROBLEM_LADDER,
  TOP_QUALITY,
  problemLoopPaths,
  problemLoopStarted,
  maxRoundDrawn,
  remainingDiffs,
  type ProblemLoopState,
} from "@/lib/problemLoopRun";
import { cardUrl } from "@/lib/cardUrl";
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

/** 지금 보여줄 작업들. 치운 것과 이틀 넘은 것은 뺀다. `?offers=1` 이면 max 확인 대기 작업의 남은 차이 목록. */
export async function GET(req: NextRequest) {
  const { supabase, user } = await sessionUser();
  if (!supabase || !user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("offers") === "1") {
    // "이게 다릅니다, 진행하시겠어요?" 창에 보여 줄 것. state 는 화면에 안 내려보내는 칸이라
    // 서비스 키로 읽되 **본인 것만** 걸러 준다.
    const { data, error } = await createAdminClient()
      .from("figure_jobs")
      .select("id, label, input_path, state")
      .eq("user_id", user.id)
      .eq("status", "done")
      .eq("stage", "max-offer")
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      offers: (data ?? []).map((r) => {
        const rem = remainingDiffs(r.state);
        return {
          id: r.id as string,
          label: r.label as string,
          quality: rem ? qualityLabel(rem.quality) : null,
          diffs: (rem?.diffs ?? []).slice(0, 30),
          // 양쪽을 나란히 보여 주려고 — 원본(넣을 때 올린 입력)과 지금 저장된 생성 그림.
          originalUrl: cardUrl(r.input_path as string),
          generatedUrl: rem?.path ? cardUrl(rem.path) : null,
        };
      }),
    });
  }
  // 이 계정이 동시에 돌릴 수 있는 작업 수(화면의 예상 시간 계산용).
  const concurrency = (await getBillingContext(supabase, user.id)).unlimited ? UNLIMITED_CONCURRENCY : 1;
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
  return NextResponse.json({ jobs: data ?? [], maxRedrawTokens: MAX_REDRAW_TOKENS, patchTokens: PATCH_REDRAW_TOKENS, topQuality: TOP_QUALITY, concurrency });
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
    inputPath?: unknown;
    payload?: unknown;
    /** 수정 모드 다시 그리기 — 우리 프로세스(검수 반복) 없이 quality=auto 로 한 번만. */
    auto?: boolean;
    /** 수정 창에서 그림 하나를 다시 그릴 때 sol 검수 흐름을 고른다. */
    sol?: boolean;
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
  if (body.mode === "passage") return enqueuePassage(req, body, supabase, user.id);

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
          ? body.instruction.slice(0, 2500).trim() || null
          : null,
      input_path: inputPath,
      ...(mode === "problem" && body.auto === true ? { payload: { auto: true } } : {}),
      ...(body.sol === true && (mode === "figure" || (mode === "problem" && body.auto !== true)) ? { payload: { sol: true } } : {}),
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
  let body: { id?: string; action?: string; problemId?: string; instruction?: string; includeDiffs?: boolean; useSol?: boolean; plan?: unknown; understood?: unknown };
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

  // **max 로 고쳐 그리기 확인.** medium 까지 해도 차이가 남은 문제는 가장 나은 그림이 이미 저장돼 있고
  // 작업이 `max-offer` 로 멈춰 있다. 여기서 확인하면 토큰을 걷고 max 라운드를 이어서 돌린다.
  if (body.action === "max") {
    const { data: row } = await admin
      .from("figure_jobs")
      .select("id, status, stage, mode, state")
      .eq("id", body.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "작업을 찾지 못했어요." }, { status: 404 });
    if (row.status !== "done" || row.stage !== "max-offer" || !row.state) {
      return NextResponse.json({ error: `${TOP_QUALITY} 로 고쳐 그릴 수 있는 작업이 아니에요.` }, { status: 409 });
    }
    const billing = await getBillingContext(supabase, user.id);
    if (billing.byok && !billing.byokApiKey) {
      return NextResponse.json(
        { error: "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요." },
        { status: 402 },
      );
    }
    const charge = !billing.unlimited && !billing.byok;
    if (charge) {
      const { data, error } = await supabase.rpc("consume_recognition_credit", {
        p_amount: MAX_REDRAW_TOKENS,
      });
      if (error || data === null) {
        return NextResponse.json(
          {
            error: error
              ? error.message
              : `토큰이 부족해요. ${TOP_QUALITY} 로 고쳐 그리려면 ${MAX_REDRAW_TOKENS}토큰이 필요합니다.`,
          },
          { status: error ? 500 : 402 },
        );
      }
    }
    const { data, error } = await admin
      .from("figure_jobs")
      .update({
        status: "pending",
        stage: `gen:${PROBLEM_LADDER.length - 1}`,
        state: { ...(row.state as ProblemLoopState), maxPhase: true },
        note: `${TOP_QUALITY} 로 고쳐 그리는 중`,
        error: null,
        started_at: null,
        finished_at: null,
        charged: charge,
        charged_tokens: charge ? MAX_REDRAW_TOKENS : 0,
      })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .eq("status", "done")
      .eq("stage", "max-offer")
      .select(JOB_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      // 기기 둘에서 동시에 눌렀거나 그 사이 닫혔다 — 방금 건 토큰은 돌려준다.
      if (charge) {
        await admin.rpc("refund_recognition_credit_for", {
          p_user_id: user.id,
          p_amount: MAX_REDRAW_TOKENS,
        });
      }
      return NextResponse.json({ error: "이미 처리됐거나 닫힌 작업이에요." }, { status: 409 });
    }
    await kickWorker(admin, redirectBase(req), user.id);
    return NextResponse.json({ job: data });
  }

  // **수정**: 다시 그리지 않고 지금 저장된 그림(보통 medium)에서 사용자가 적은 곳만 고친다. quality 미지정, sol 검수
  // 없음. PATCH_REDRAW_TOKENS(150)를 걷는다.
  if (body.action === "patch") {
    const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 1000) : "";
    // **sol 과 대화로 확정한 수정 사항**(`SolChat`). 있으면 해석 걸음을 건너뛰고 곧바로 강한 편집 지시로 그린다.
    const chatPlan = typeof body.plan === "string" ? body.plan.trim().slice(0, 4000) : "";
    const chatUnderstood = typeof body.understood === "string" ? body.understood.trim().slice(0, 400) : "";
    const includeDiffs = chatPlan ? false : body.includeDiffs !== false;
    const useSol = chatPlan ? true : body.useSol !== false;
    if (!chatPlan && !instruction && !includeDiffs) {
      return NextResponse.json({ error: "고칠 내용을 적거나 남은 차이를 함께 고치도록 골라주세요." }, { status: 400 });
    }
    const { data: row } = await admin
      .from("figure_jobs")
      .select("id, status, stage, state")
      .eq("id", body.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "작업을 찾지 못했어요." }, { status: 404 });
    if (row.status !== "done" || row.stage !== "max-offer" || !row.state) {
      return NextResponse.json({ error: "수정할 수 있는 작업이 아니에요." }, { status: 409 });
    }
    if (includeDiffs && !instruction && !remainingDiffs(row.state)?.diffs.length) {
      return NextResponse.json({ error: "함께 고칠 남은 차이가 없어요. 고칠 내용을 적어주세요." }, { status: 400 });
    }
    const billing = await getBillingContext(supabase, user.id);
    if (billing.byok && !billing.byokApiKey) {
      return NextResponse.json(
        { error: "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요." },
        { status: 402 },
      );
    }
    const charge = !billing.unlimited && !billing.byok;
    if (charge) {
      const { data, error } = await supabase.rpc("consume_recognition_credit", { p_amount: PATCH_REDRAW_TOKENS });
      if (error || data === null) {
        return NextResponse.json(
          { error: error ? error.message : `토큰이 부족해요. 수정하려면 ${PATCH_REDRAW_TOKENS}토큰이 필요합니다.` },
          { status: error ? 500 : 402 },
        );
      }
    }
    const { data, error } = await admin
      .from("figure_jobs")
      .update({
        status: "pending",
        // sol 을 고르면 해석 걸음부터, 아니면 곧바로 그린다.
        stage: useSol && !chatPlan ? "patch-plan" : "patch",
        state: {
          ...(row.state as ProblemLoopState),
          patchPhase: true,
          patch: chatPlan
            ? { instruction, includeDiffs: false, useSol: true, plan: chatPlan, understood: chatUnderstood || undefined }
            : { instruction, includeDiffs, useSol },
        },
        note: chatPlan
          ? `확정한 수정 사항대로 고치는 중${chatUnderstood ? ` · ${chatUnderstood}` : ""}`
          : useSol
            ? "sol 이 원본과 비교해 요청을 해석하는 중"
            : "적어 주신 곳을 수정하는 중",
        error: null,
        started_at: null,
        finished_at: null,
        charged: charge,
        charged_tokens: charge ? PATCH_REDRAW_TOKENS : 0,
      })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .eq("status", "done")
      .eq("stage", "max-offer")
      .select(JOB_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      if (charge) {
        await admin.rpc("refund_recognition_credit_for", { p_user_id: user.id, p_amount: PATCH_REDRAW_TOKENS });
      }
      return NextResponse.json({ error: "이미 처리됐거나 닫힌 작업이에요." }, { status: 409 });
    }
    await kickWorker(admin, redirectBase(req), user.id);
    return NextResponse.json({ job: data });
  }

  // max 는 안 돌리고 지금 저장된 그림으로 둔다 — 붙들고 있던 입력·중간 그림을 지운다.
  if (body.action === "skipMax") {
    const { data: row } = await admin
      .from("figure_jobs")
      .select("input_path, state")
      .eq("id", body.id)
      .eq("user_id", user.id)
      .eq("status", "done")
      .eq("stage", "max-offer")
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "닫을 작업이 없어요." }, { status: 409 });
    const { data: closed } = await admin
      .from("figure_jobs")
      .update({ stage: "done", state: null, note: "더 고쳐 그리지 않고 지금 그림으로 두었어요" })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .eq("status", "done")
      .eq("stage", "max-offer")
      .select("id")
      .maybeSingle();
    if (closed) await removeStored(admin, [row.input_path as string, ...problemLoopPaths(row.state)]);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "retry") {
    const { data: row } = await admin
      .from("figure_jobs")
      .select("id, status, charged, mode, stage, payload")
      .eq("id", body.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "작업을 찾지 못했어요." }, { status: 404 });
    if (row.status !== "error") {
      return NextResponse.json({ error: "실패한 작업만 다시 돌릴 수 있어요." }, { status: 409 });
    }
    const billing = await getBillingContext(supabase, user.id);
    // 지문 작업은 **실패한 단계부터** 잇는다 — 그 뒤 단계 몫만 다시 건다.
    const deposit =
      row.mode === "passage"
        ? passageDepositFrom(
            row.stage,
            ((row.payload ?? null) as PassagePayload | null)?.figures.length ?? 0,
          )
        : FIGURE_TOKEN_DEPOSIT;
    const patch: Record<string, unknown> = {
      status: "pending",
      error: null,
      finished_at: null,
      started_at: null,
      // 문제 통째로 그리기는 그리기·검수를 단계로 도는데, 다시 시도는 깨끗이 처음부터 한다.
      ...(row.mode === "problem" || (row.payload as { sol?: boolean } | null)?.sol ? { stage: null, state: null, note: null } : {}),
    };
    if (!billing.unlimited && !billing.byok && !row.charged) {
      const { data, error } = await supabase.rpc("consume_recognition_credit", {
        p_amount: deposit,
      });
      if (error || data === null) {
        return NextResponse.json(
          {
            error: error
              ? error.message
              : `토큰이 부족해요. 다시 돌리려면 최소 ${deposit}토큰이 필요합니다.`,
          },
          { status: error ? 500 : 402 },
        );
      }
      patch.charged = true;
      patch.charged_tokens = deposit;
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
          p_amount: deposit,
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
    .select("input_path, payload, charged, charged_tokens, state")
    .maybeSingle();
  if (removed) {
    // 그리기가 이미 시작된 작업(단계 사이에 줄에 서 있는 것)은 **돈이 나간 뒤**라 돌려주지 않는다 —
    // 치우기만 해도 전액이 돌아오면 그려 놓고 취소하는 길이 열린다.
    // max 를 확인받고 줄에 선 작업(아직 max 를 안 그렸다)은 걷은 200토큰을 돌려준다.
    const st = removed.state as ProblemLoopState | null;
    const maxNotDrawn = st?.patchPhase === true || (st?.maxPhase === true && !maxRoundDrawn(st));
    const spent = problemLoopStarted(removed.state) && !maxNotDrawn;
    if (removed.charged && removed.charged_tokens > 0 && !spent) {
      await admin.rpc("refund_recognition_credit_for", {
        p_user_id: user.id,
        p_amount: removed.charged_tokens,
      });
    }
    await removeStored(admin, [...passageInputPaths(removed), ...problemLoopPaths(removed.state)]);
    return NextResponse.json({ ok: true, refunded: removed.charged && !spent });
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
    .select("status, stage, input_path, payload, state")
    .maybeSingle();
  // 실패한 작업은 다시 시도하려고 입력을 남겨 뒀다 — 치웠으니 지운다(중간 그림도).
  // max 확인을 기다리던 작업도 입력·중간 그림을 들고 있었다.
  if (finished?.status === "error" || finished?.stage === "max-offer") {
    await removeStored(admin, [...passageInputPaths(finished), ...problemLoopPaths(finished.state)]);
  }
  return NextResponse.json({ ok: true });
}

/** 수정 라운드(`patch1`)는 "수정 1차"로 보여 준다. */
function qualityLabel(q: string): string {
  const m = /^patch(\d+)$/.exec(q);
  return m ? `수정 ${m[1]}차` : q;
}

/** 지문 입력 경로는 **자기 `_jobs/` 아래**만 받는다 — 남의 파일을 읽히면 안 된다. */
function ownJobPath(v: unknown, userId: string): v is string {
  return (
    typeof v === "string" &&
    v.length < 300 &&
    v.startsWith(`${userId}/_jobs/`) &&
    !v.includes("..") &&
    /^[\w./-]+$/.test(v)
  );
}

function readPayload(v: unknown, userId: string): PassagePayload | null {
  const o = v as Record<string, unknown> | null;
  if (!o || !ownJobPath(o.overview, userId)) return null;
  const list = (x: unknown, max: number) =>
    Array.isArray(x) && x.length <= max && x.every((p) => ownJobPath(p, userId)) ? (x as string[]) : null;
  const strips = list(o.strips, 12);
  const figuresSmall = list(o.figuresSmall, 8);
  if (!strips || !figuresSmall || !Array.isArray(o.figures) || o.figures.length !== figuresSmall.length) {
    return null;
  }
  const figures: PassagePayload["figures"] = [];
  for (const f of o.figures as Record<string, unknown>[]) {
    if (!ownJobPath(f?.path, userId)) return null;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
    figures.push({
      path: f.path,
      scale: Math.min(1, Math.max(0.1, num(f.scale) ?? 0.8)),
      width: num(f.width),
      height: num(f.height),
    });
  }
  return { overview: o.overview, strips, figuresSmall, figures };
}

/**
 * **지문 인식**을 줄에 세운다(`passageRun.ts`). 입력(지문 사진·확대 띠·그림)은
 * 브라우저가 미리 `<uid>/_jobs/` 에 올려 두고 경로만 보낸다 — 한 요청에 다 실으면
 * 4.5MB 한도를 넘는다. 지문 행이 먼저 저장돼 있어야 한다(결과를 그 행에 쓴다).
 */
async function enqueuePassage(
  req: NextRequest,
  body: {
    figureId?: string;
    problemKey?: string;
    label?: string;
    problemId?: string | null;
    inputPath?: unknown;
    payload?: unknown;
  },
  supabase: NonNullable<Awaited<ReturnType<typeof sessionUser>>["supabase"]>,
  userId: string,
) {
  const figureId = typeof body.figureId === "string" ? body.figureId.slice(0, 100) : "";
  const payload = readPayload(body.payload, userId);
  if (!figureId || !ownJobPath(body.inputPath, userId) || !payload) {
    return NextResponse.json({ error: "지문 입력을 받지 못했어요." }, { status: 400 });
  }
  const inputPath = body.inputPath;
  const { data: problem } = await supabase
    .from("problems")
    .select("id")
    .eq("id", typeof body.problemId === "string" ? body.problemId : "")
    .maybeSingle();
  if (!problem) return NextResponse.json({ error: "지문을 찾지 못했어요." }, { status: 404 });

  const billing = await getBillingContext(supabase, userId);
  if (billing.byok && !billing.byokApiKey) {
    return NextResponse.json(
      { error: "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요." },
      { status: 402 },
    );
  }
  if (!billing.byok && !process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY 가 설정되지 않아 지문 인식을 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  const admin = createAdminClient();
  const inputs = passageInputPaths({ input_path: inputPath, payload });
  const existing = await admin
    .from("figure_jobs")
    .select(JOB_COLUMNS)
    .eq("user_id", userId)
    .eq("figure_id", figureId)
    .in("status", ["pending", "running"])
    .eq("dismissed", false)
    .maybeSingle();
  if (existing.data) {
    await removeStored(admin, inputs);
    return NextResponse.json({ job: existing.data });
  }

  const jobId = crypto.randomUUID();
  const inserted = await admin
    .from("figure_jobs")
    .insert({
      id: jobId,
      user_id: userId,
      figure_id: figureId,
      problem_key: typeof body.problemKey === "string" ? body.problemKey.slice(0, 200) : "",
      problem_id: problem.id,
      label: typeof body.label === "string" ? body.label.slice(0, 100) : "",
      mode: "passage",
      korean: true,
      input_path: inputPath,
      payload,
      stage: "read",
    })
    .select(JOB_COLUMNS)
    .single<FigureJobRow>();
  if (inserted.error || !inserted.data) {
    await removeStored(admin, inputs);
    return NextResponse.json(
      { error: inserted.error?.message ?? "작업을 넣지 못했어요." },
      { status: inserted.error?.code === "23505" ? 409 : 500 },
    );
  }

  let job = inserted.data;
  if (!billing.unlimited && !billing.byok) {
    const deposit = passageDepositFrom("read", payload.figures.length);
    const { data, error } = await supabase.rpc("consume_recognition_credit", { p_amount: deposit });
    if (error || data === null) {
      await admin.from("figure_jobs").delete().eq("id", jobId);
      await removeStored(admin, inputs);
      return NextResponse.json(
        {
          error: error
            ? error.message
            : `토큰이 부족해요. 지문 인식에는 최소 ${deposit}토큰이 필요합니다(남는 몫은 돌려드려요).`,
        },
        { status: error ? 500 : 402 },
      );
    }
    const charged = await admin
      .from("figure_jobs")
      .update({ charged: true, charged_tokens: deposit })
      .eq("id", jobId)
      .select(JOB_COLUMNS)
      .single<FigureJobRow>();
    if (charged.data) job = charged.data;
  }

  await kickWorker(admin, redirectBase(req), userId);
  return NextResponse.json({ job });
}
