import { NextRequest, NextResponse } from "next/server";
import { redirectBase } from "@/app/auth/redirectBase";
import { getBillingContext } from "@/lib/byok";
import {
  loadAsDataUrl,
  persistFigureMaterial,
  persistWholeProblem,
  pickModelIds,
  removeStored,
  runFigureGeneration,
  splitDataUrl,
  storeBytes,
  visibleUsage,
} from "@/lib/figureRun";
import { logAiCost } from "@/lib/costLog";
import { kickWorker, workerToken } from "@/lib/figureJobsServer";
import { callOpenAIVision } from "@/lib/detectProblems";
import { pollKoreanTextBackground, startKoreanTextBackground } from "@/lib/gradeExam";
import {
  passageInputPaths,
  runPassageStage,
  type PassagePayload,
  type PassageState,
} from "@/lib/passageRun";
import {
  PROBLEM_LADDER,
  problemLoopEnabled,
  problemLoopPaths,
  runProblemStage,
  type ProblemLoopState,
} from "@/lib/problemLoopRun";
import type { FigureUsage } from "@/lib/figureImageGen";

/** 확인용 64×64 PNG(청크 CRC 까지 검사한 것 — `/api/figure/models` 와 같은 파일). */
const PROBE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAYElEQVR42u3QAQ0AAAwCIPuX1hzfIQLpcxEgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQLuG0bQw7Ko2TvAAAAAAElFTkSuQmCC";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 생성에 쓸 시간. 함수 한도(300초)보다 넉넉히 앞에서 우리가 끊어야 **환불과
 * 기록이 돌 수 있다** — Vercel 이 먼저 죽이면 아무것도 못 남긴다. 앞뒤로
 * 입력 내려받기·결과 올리기·DB 기록이 있어 `/api/figure` 보다 여유를 더 둔다.
 */
const GENERATION_MS = 255_000;

type ClaimedJob = {
  id: string;
  user_id: string;
  figure_id: string;
  problem_id: string | null;
  mode: "figure" | "problem" | "passage";
  korean: boolean;
  instruction: string | null;
  input_path: string;
  width: number | null;
  height: number | null;
  charged: boolean;
  charged_tokens: number;
  dismissed: boolean;
  payload: (PassagePayload & { auto?: boolean }) | null;
  stage: string | null;
  state: PassageState | ProblemLoopState | null;
};

/**
 * 지문 한 단계에 쓸 시간. 지문 읽기(sol)는 그림 생성보다 오래 걸릴 수 있어
 * 더 준다 — 앞뒤로 입력 내려받기·DB 기록이 짧아서 300초 안에 들어간다.
 */
const PASSAGE_STAGE_MS = 270_000;

/**
 * 서버 큐의 일꾼. **브라우저가 없어도 돈다** — 작업을 넣은 라우트, 앞선 일꾼,
 * pg_cron(1분마다) 셋 중 누구든 이걸 부른다. 한 번에 한 작업만 하고, 끝나면
 * 다음 일꾼을 부르고 물러난다(한 함수가 줄을 통째로 붙들면 300초 한도에 걸린다).
 *
 * 인증은 DB 안에만 있는 비밀값(`x-worker-token`)으로 한다. 이 라우트는 로그인
 * 가드를 안 탄다(미들웨어가 통과시킨다) — 부르는 쪽에 세션이 없기 때문이다.
 */
export async function POST(req: NextRequest) {
  const admin = createAdminClient();
  const token = await workerToken(admin);
  const given = req.headers.get("x-worker-token");
  if (!token || !given || given !== token) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let preferUser: string | null = null;
  let probe: string | null = null;
  let probeModel = "";
  let probeEffort = "";
  let probeId = "";
  try {
    const body = (await req.json()) as {
      preferUser?: unknown;
      probe?: unknown;
      model?: unknown;
      effort?: unknown;
    };
    if (typeof body.effort === "string") probeEffort = body.effort;
    if (typeof (body as { id?: unknown }).id === "string") probeId = (body as { id: string }).id;
    if (typeof body.preferUser === "string") preferUser = body.preferUser;
    if (typeof body.probe === "string") probe = body.probe;
    if (typeof body.model === "string") probeModel = body.model;
  } catch {
    // 본문이 없어도 된다(pg_cron 은 빈 객체를 보낸다).
  }

  // **모델 이름 확인용.** 이 계정이 실제로 부를 수 있는 gpt 이름 목록을 준다
  // (`/v1/models` 조회는 무료). 모델 이름을 짐작해서 바꿨다가 기능이 통째로
  // 죽은 적이 있어서, 바꾸기 전에 여기서 먼저 확인한다. 이름만 돌려주고 키는
  // 절대 내보내지 않는다. 같은 비밀값으로만 열린다.
  if (probe === "models") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return NextResponse.json({ error: "no key" }, { status: 500 });
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 502 });
    const ids: string[] = ((await res.json())?.data ?? [])
      .map((m: { id?: string }) => String(m.id ?? ""))
      .filter((id: string) => id.startsWith("gpt"))
      .sort();
    return NextResponse.json({ models: ids });
  }
  // **백그라운드 호출 확인용**(비교 화면이 쓰는 길). 작은 그림 한 장으로 걸어
  // 보고(`bg-start`) id 로 물어본다(`bg-poll`). 모델이 background 를 안 받으면
  // 시작에서 바로 오류가 난다.
  if (probe === "bg-start") {
    if (!/^gpt-[\w.-]+$/.test(probeModel)) {
      return NextResponse.json({ error: "model 이 필요합니다." }, { status: 400 });
    }
    try {
      const id = await startKoreanTextBackground(
        `data:image/png;base64,${PROBE_PNG}`,
        probeModel,
        /^[a-z]{1,16}$/.test(probeEffort) ? probeEffort : undefined,
      );
      return NextResponse.json({ ok: true, id });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    }
  }
  if (probe === "bg-poll") {
    if (!/^resp_[\w-]{8,200}$/.test(probeId)) {
      return NextResponse.json({ error: "id 가 필요합니다." }, { status: 400 });
    }
    return NextResponse.json(await pollKoreanTextBackground(probeId));
  }
  // Gemini 쪽 이름 확인용. 이 키로 부를 수 있는 모델 이름과 지원하는 호출
  // 방식만 준다(ListModels 는 무료). 키는 내보내지 않는다.
  if (probe === "gemini-models") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return NextResponse.json({ error: "no key" }, { status: 500 });
    const names: string[] = [];
    let pageToken = "";
    for (let i = 0; i < 5; i++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${
          pageToken ? `&pageToken=${pageToken}` : ""
        }&key=${key}`,
      );
      if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 502 });
      const json = (await res.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of json.models ?? []) {
        if (m.supportedGenerationMethods?.includes("generateContent")) {
          names.push(String(m.name ?? "").replace(/^models\//, ""));
        }
      }
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return NextResponse.json({ models: names.sort() });
  }
  // 모델을 바꾸기 전에 **그 모델이 우리 요청 모양(사진 + JSON 응답)을 받는지**
  // 64×64 그림 한 장으로 확인한다(100토큰 안쪽). 목록에 이름이 있어도 받는
  // 파라미터가 다르면 채점·영역 찾기가 통째로 죽기 때문이다.
  if (probe === "vision") {
    const model = probeModel;
    if (!/^gpt-[\w.-]+$/.test(model)) {
      return NextResponse.json({ error: "model 이 필요합니다." }, { status: 400 });
    }
    const t0 = Date.now();
    try {
      const text = await callOpenAIVision(
        `data:image/png;base64,${PROBE_PNG}`,
        'Reply ONLY with a JSON object: {"ok": true, "shape": "<what you see>"}',
        model,
        /^[a-z]{1,16}$/.test(probeEffort) ? probeEffort : undefined,
      );
      return NextResponse.json({
        ok: true,
        model,
        effort: probeEffort || null,
        ms: Date.now() - t0,
        text: text.slice(0, 300),
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        model,
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err),
      });
    }
  }

  const { data: claimed, error: claimErr } = await admin.rpc("claim_figure_job", {
    p_prefer_user: preferUser,
  });
  if (claimErr) {
    console.error("[figure-jobs/run] claim 실패:", claimErr.message);
    return NextResponse.json({ error: claimErr.message }, { status: 500 });
  }
  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as ClaimedJob | undefined;
  if (!job) {
    await sweepOldInputs(admin);
    return NextResponse.json({ idle: true });
  }

  const base = redirectBase(req);
  try {
    await runJob(admin, job);
  } catch (err) {
    // runJob 은 스스로 실패를 기록하지만, 거기서도 못 잡은 것이 있으면 여기서.
    console.error("[figure-jobs/run] 예상 못 한 오류:", err);
    await fail(admin, job, err instanceof Error ? err.message : "알 수 없는 오류");
  }

  // 다음 사람(같은 사람을 먼저) 작업을 이어서 집게 한다.
  await kickWorker(admin, base, job.user_id);
  return NextResponse.json({ ok: true, id: job.id });
}

type Admin = ReturnType<typeof createAdminClient>;

/** 실패로 적고 보증금을 돌려준다. 입력은 다시 시도할 수 있게 남긴다. */
async function fail(admin: Admin, job: ClaimedJob, message: string) {
  const { data } = await admin
    .from("figure_jobs")
    .update({
      status: "error",
      error: message.slice(0, 1000),
      finished_at: new Date().toISOString(),
      charged: false,
      charged_tokens: 0,
    })
    .eq("id", job.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  // 이미 누가(멈춘 작업 정리) 오류로 돌려놨으면 환불도 거기서 했다 — 두 번 주지 않는다.
  if (data && job.charged && job.charged_tokens > 0) {
    await admin.rpc("refund_recognition_credit_for", {
      p_user_id: job.user_id,
      p_amount: job.charged_tokens,
    });
  }
}

async function runJob(admin: Admin, job: ClaimedJob) {
  if (job.mode === "passage") return runPassageJob(admin, job);
  // 문제 통째로 그리기는 그리기 → sol 검수 → 고쳐 그리기를 단계별로 돈다.
  // **수정 모드의 다시 그리기는 우리 프로세스(그리기 → sol 검수 → 고쳐 그리기)를 타지 않는다**(사용자 —
  // "수정모드에서는 우리 프로세스가 아니라 auto 로 해서 sol 검증 없이 가는 거고"). 한 번, quality=auto.
  const auto = job.payload?.auto === true;
  if (job.mode === "problem" && problemLoopEnabled() && !auto) return runProblemLoopJob(admin, job);
  const tag = `figure-jobs/run ${job.id.slice(0, 8)}`;
  const image = await loadAsDataUrl(admin, job.input_path);
  if (!image) {
    await fail(admin, job, "올려 둔 그림을 찾지 못했어요. 다시 넣어주세요.");
    return;
  }

  const billing = await getBillingContext(admin, job.user_id);
  if (billing.byok && !billing.byokApiKey) {
    await fail(
      admin,
      job,
      "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요.",
    );
    return;
  }

  const outcome = await runFigureGeneration({
    image,
    mode: job.mode,
    korean: job.korean,
    instruction: job.instruction ?? undefined,
    inputSize:
      job.width && job.height ? { width: job.width, height: job.height } : undefined,
    modelIds: pickModelIds(billing.byok, billing.byokModel),
    byokApiKey: billing.byokApiKey ?? undefined,
    deadlineMs: GENERATION_MS,
    tag,
    ...(auto ? { quality: "auto" } : {}),
  });
  if (!outcome.ok) {
    await fail(admin, job, outcome.error);
    return;
  }
  if (outcome.usage && !billing.byok) {
    await logAiCost(admin, {
      userId: job.user_id,
      jobId: job.id,
      kind: job.mode === "problem" ? "problem" : "figure",
      what: job.mode === "problem" ? "그림" : "그림 하나",
      krw: outcome.usage.estKrw,
      usd: outcome.usage.estUsd,
    });
  }
  await finishJob(admin, job, {
    dataUrl: outcome.dataUrl,
    modelId: outcome.modelId,
    usage: outcome.usage,
    showMoney: billing.unlimited || billing.byok,
    tag,
  });
}

/**
 * 다 그린 그림을 저장하고 작업을 끝낸다. 한 번에 그리는 길과 그리기·검수를 반복하는 길이
 * 같이 쓴다 — 저장 규칙이 두 벌이 되면 한쪽만 고쳐진다.
 */
async function finishJob(
  admin: Admin,
  job: ClaimedJob,
  out: {
    dataUrl: string;
    modelId: string;
    usage?: FigureUsage;
    showMoney: boolean;
    tag: string;
    note?: string;
    /** max 확인을 기다리는 상태(입력·중간 그림을 남기고 `max-offer` 로 끝낸다). */
    offer?: ProblemLoopState;
  },
) {
  const { tag } = out;
  // 문제 전체는 결과가 곧 카드다 — 그 행에 바로 저장하면 끝난다.
  // 그림 하나는 결과만 따로 두고 재료(box_range)에 먼저 넣는다. 카드 PNG 는
  // 앱이 열려 있을 때 브라우저가 다시 그린다(`FigureJobsProvider`).
  let resultPath: string | null = null;
  let applied = false;
  if (job.mode === "problem" && job.problem_id) {
    resultPath = await persistWholeProblem(
      admin,
      job.problem_id,
      job.figure_id,
      out.dataUrl,
      job.user_id,
    );
    applied = resultPath !== null;
  }
  if (!resultPath) {
    const parts = splitDataUrl(out.dataUrl);
    if (!parts) {
      await fail(admin, job, "서버가 이미지를 돌려주지 않았어요.");
      return;
    }
    const path = `${job.user_id}/_jobs/${job.id}.${parts.ext}`;
    if (!(await storeBytes(admin, path, parts.bytes, parts.mime))) {
      await fail(admin, job, "완성된 그림을 저장하지 못했어요. 다시 시도해주세요.");
      return;
    }
    resultPath = path;
    if (job.mode === "figure" && job.problem_id) {
      await persistFigureMaterial(admin, job.problem_id, job.figure_id, path, job.user_id);
    }
  }

  const now = new Date().toISOString();
  const { data: saved } = await admin
    .from("figure_jobs")
    .update({
      status: "done",
      result_path: resultPath,
      applied_at: applied ? now : null,
      model: out.modelId,
      usage: visibleUsage(out.usage, out.showMoney) ?? null,
      finished_at: now,
      ...(out.note !== undefined
        ? out.offer
          ? { note: out.note, stage: "max-offer", state: out.offer }
          : { note: out.note, stage: "done", state: null }
        : {}),
    })
    .eq("id", job.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();

  if (!saved) {
    // 7분이 넘어 멈춘 작업 정리가 먼저 오류로 돌려놓고 **환불까지 했다.**
    // 결과는 이미 저장됐으니 버리지 않되, 표는 건드리지 않는다.
    console.warn(`[${tag}] 이미 정리된 작업이라 결과 기록을 건너뜀`);
    return;
  }
  // 성공했으면 입력은 더 쓸 일이 없다(다시 그리기는 새 작업이다). max 확인을 기다리는 작업은
  // 이어서 그리려면 입력이 필요하니 남긴다.
  if (!out.offer) await removeStored(admin, [job.input_path]);
}

/**
 * max 다시 그리기가 **그림을 못 만들었을 때**: 걷은 토큰을 돌려주고 확인 대기(`max-offer`)로 되돌린다.
 * 문제에는 이미 medium 까지의 가장 나은 그림이 저장돼 있어 잃는 것이 없다. 입력·중간 그림은 그대로 둔다.
 */
async function revertMax(admin: Admin, job: ClaimedJob, why: string, tag: string) {
  const state = (job.state ?? null) as ProblemLoopState | null;
  const refund = job.charged ? job.charged_tokens : 0;
  const now = new Date().toISOString();
  const { data } = await admin
    .from("figure_jobs")
    .update({
      status: "done",
      stage: "max-offer",
      state: state ? { ...state, maxPhase: false, patchPhase: false, patch: undefined } : null,
      note: `${state?.patchPhase ? "수정" : `${PROBLEM_LADDER[PROBLEM_LADDER.length - 1]} 그리기`}에 실패했어요${refund > 0 ? ` — ${refund}토큰은 돌려드렸어요` : ""} · 다시 시도할 수 있어요 (${why.slice(0, 120)})`,
      charged: false,
      charged_tokens: 0,
      finished_at: now,
    })
    .eq("id", job.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (!data) {
    console.warn(`[${tag}] 이미 정리된 작업이라 max 되돌리기를 건너뜀`);
    return;
  }
  if (refund > 0) {
    await admin.rpc("refund_recognition_credit_for", { p_user_id: job.user_id, p_amount: refund });
  }
}

/**
 * 문제 통째로 그리기의 **한 단계**(그리기 또는 sol 검수)를 돌린다(`problemLoopRun.ts`).
 * 다음 단계가 있으면 줄에 되돌려 세우고(pending), 다음 일꾼이 이어서 집는다.
 */
async function runProblemLoopJob(admin: Admin, job: ClaimedJob) {
  const tag = `figure-jobs/run ${job.id.slice(0, 8)} 문제`;
  const billing = await getBillingContext(admin, job.user_id);
  if (billing.byok && !billing.byokApiKey) {
    await fail(
      admin,
      job,
      "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요.",
    );
    return;
  }
  const out = await runProblemStage(
    admin,
    { ...job, state: (job.state ?? null) as ProblemLoopState | null },
    {
      byokApiKey: billing.byokApiKey ?? undefined,
      modelIds: pickModelIds(billing.byok, billing.byokModel),
      deadlineMs: GENERATION_MS,
      tag,
    },
  );
  const inMax = (job.state as ProblemLoopState | null)?.maxPhase === true;
  const inPatch = (job.state as ProblemLoopState | null)?.patchPhase === true;
  if (out.kind === "fail") {
    if (inMax || inPatch) {
      // max 그리기가 안 됐다 — 이미 저장된 그림은 그대로다. 걷은 토큰을 돌려주고 확인 상태로 돌아간다.
      await revertMax(admin, job, out.error, tag);
      return;
    }
    await removeStored(admin, out.cleanup);
    await fail(admin, job, out.error);
    return;
  }
  if (out.kind === "done") {
    // max 를 확인받고 돌렸는데 max 그림이 안 나왔다(그리기 실패) — 돈을 받을 일이 아니다.
    if (inMax && out.rounds < PROBLEM_LADDER.length) {
      await revertMax(admin, job, out.note, tag);
      return;
    }
    await finishJob(admin, job, {
      dataUrl: out.dataUrl,
      modelId: out.modelId,
      usage: out.usage,
      showMoney: billing.unlimited || billing.byok,
      tag,
      note: out.note,
      offer: out.offer,
    });
    if (!out.offer) await removeStored(admin, out.cleanup);
    return;
  }
  const { data: saved } = await admin
    .from("figure_jobs")
    .update({
      status: "pending",
      stage: out.stage,
      state: out.state,
      note: out.note,
      started_at: null,
    })
    .eq("id", job.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (!saved) {
    // 멈춘 작업 정리가 먼저 오류로 돌려놓고 환불했다 — 만든 중간 그림만 치운다.
    console.warn(`[${tag}] 이미 정리된 작업이라 기록을 건너뜀`);
    await removeStored(admin, out.state.rounds.map((r) => r.path));
  }
}

/**
 * 지문 작업의 **한 단계**를 돌린다(`passageRun.ts`). 다음 단계가 있으면 줄에
 * 되돌려 세우고(pending), 다음 일꾼이 이어서 집는다.
 */
async function runPassageJob(admin: Admin, job: ClaimedJob) {
  const tag = `figure-jobs/run ${job.id.slice(0, 8)} 지문`;
  const billing = await getBillingContext(admin, job.user_id);
  if (billing.byok && !billing.byokApiKey) {
    await fail(
      admin,
      job,
      "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요.",
    );
    return;
  }
  const out = await runPassageStage(admin, { ...job, state: (job.state ?? null) as PassageState | null }, {
    byokApiKey: billing.byokApiKey ?? undefined,
    modelIds: pickModelIds(billing.byok, billing.byokModel),
    deadlineMs: PASSAGE_STAGE_MS,
    tag,
  });
  if (out.kind === "fail") {
    await fail(admin, job, out.error);
    return;
  }

  // `charged_tokens` 는 **아직 안 쓴 보증금**이다. 이번 단계에서 쓴 것과 돌려준
  // 것을 뺀다. 끝났으면 남은 것까지 모두 돌려주고 쓴 만큼으로 바꿔 적는다.
  const unspent = job.charged ? Math.max(0, job.charged_tokens - out.spent - out.refund) : 0;
  const refund = job.charged ? out.refund + (out.kind === "done" ? unspent : 0) : 0;
  const now = new Date().toISOString();
  const patch =
    out.kind === "next"
      ? {
          status: "pending",
          stage: out.stage,
          state: out.state,
          note: out.note,
          charged_tokens: unspent,
          started_at: null,
        }
      : {
          status: "done",
          stage: "done",
          state: null,
          note: out.note,
          charged_tokens: job.charged ? (out.state.spent ?? 0) : 0,
          applied_at: now,
          result_path: null,
          finished_at: now,
        };
  const { data: saved } = await admin
    .from("figure_jobs")
    .update(patch)
    .eq("id", job.id)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (!saved) {
    // 멈춘 작업 정리가 먼저 오류로 돌려놓고 남은 보증금을 돌려줬다 — 두 번 주지 않는다.
    console.warn(`[${tag}] 이미 정리된 작업이라 기록을 건너뜀`);
    return;
  }
  if (refund > 0) {
    await admin.rpc("refund_recognition_credit_for", { p_user_id: job.user_id, p_amount: refund });
  }
  if (out.kind === "done") await removeStored(admin, passageInputPaths(job));
}

/**
 * 실패한 채 오래 남은 작업의 입력 파일을 치운다. 실패하면 다시 시도하라고
 * 입력을 남겨 두는데, 아무도 다시 안 누르면 그대로 쌓인다. 할 일이 없을 때만
 * 조금씩(한 번에 20개) 치운다.
 */
async function sweepOldInputs(admin: Admin) {
  const before = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  // max 확인을 3일 넘게 안 받은 작업: 입력·중간 그림을 지우고 확인 대기를 닫는다(그림은 이미 저장돼 있다).
  const { data: offers } = await admin
    .from("figure_jobs")
    .select("id, input_path, state")
    .eq("status", "done")
    .eq("stage", "max-offer")
    .lt("finished_at", before)
    .limit(20);
  for (const o of offers ?? []) {
    await removeStored(admin, [o.input_path as string, ...problemLoopPaths(o.state)]);
    await admin
      .from("figure_jobs")
      .update({ stage: "done", state: null, note: "고쳐 그리기 확인 기간이 지나 닫혔어요" })
      .eq("id", o.id as string)
      .eq("stage", "max-offer");
  }
  const { data } = await admin
    .from("figure_jobs")
    .select("id, input_path, payload, state")
    .eq("status", "error")
    .lt("finished_at", before)
    .limit(20);
  if (!data || data.length === 0) return;
  await removeStored(
    admin,
    data.flatMap((r) => [
      ...passageInputPaths({
        input_path: r.input_path as string,
        payload: (r.payload ?? null) as PassagePayload | null,
      }),
      ...problemLoopPaths(r.state),
    ]),
  );
  await admin
    .from("figure_jobs")
    .delete()
    .in(
      "id",
      data.map((r) => r.id as string),
    );
}
