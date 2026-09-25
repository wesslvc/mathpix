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
import { kickWorker, workerToken } from "@/lib/figureJobsServer";
import { callOpenAIVision } from "@/lib/detectProblems";

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
  mode: "figure" | "problem";
  korean: boolean;
  instruction: string | null;
  input_path: string;
  width: number | null;
  height: number | null;
  charged: boolean;
  charged_tokens: number;
  dismissed: boolean;
};

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
  try {
    const body = (await req.json()) as {
      preferUser?: unknown;
      probe?: unknown;
      model?: unknown;
      effort?: unknown;
    };
    if (typeof body.effort === "string") probeEffort = body.effort;
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
  });
  if (!outcome.ok) {
    await fail(admin, job, outcome.error);
    return;
  }

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
      outcome.dataUrl,
      job.user_id,
    );
    applied = resultPath !== null;
  }
  if (!resultPath) {
    const parts = splitDataUrl(outcome.dataUrl);
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
      model: outcome.modelId,
      usage: visibleUsage(outcome.usage, billing.unlimited || billing.byok) ?? null,
      finished_at: now,
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
  // 성공했으면 입력은 더 쓸 일이 없다(다시 그리기는 새 작업이다).
  await removeStored(admin, [job.input_path]);
}

/**
 * 실패한 채 오래 남은 작업의 입력 파일을 치운다. 실패하면 다시 시도하라고
 * 입력을 남겨 두는데, 아무도 다시 안 누르면 그대로 쌓인다. 할 일이 없을 때만
 * 조금씩(한 번에 20개) 치운다.
 */
async function sweepOldInputs(admin: Admin) {
  const before = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data } = await admin
    .from("figure_jobs")
    .select("id, input_path")
    .eq("status", "error")
    .lt("finished_at", before)
    .limit(20);
  if (!data || data.length === 0) return;
  await removeStored(
    admin,
    data.map((r) => r.input_path as string),
  );
  await admin
    .from("figure_jobs")
    .delete()
    .in(
      "id",
      data.map((r) => r.id as string),
    );
}
