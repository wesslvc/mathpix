import { createClient } from "@/lib/supabase/client";
import { putBlob, removeBlobs } from "./blobClient";
import { ensureDataUrl } from "./figureImage";
import { r2DirectReady } from "./r2Direct";

/**
 * **짧은 AI 작업을 서버 대기열에 넣고 결과를 기다린다**(브라우저 쪽). 서버 쪽은 `aiTasks.ts`.
 *
 * 사용자 — "모든 ai작업은 서버에서 돌리고 사용자한테 대기열에 들어가서 진행중인걸 볼수있게할것"(2026-10-01).
 * 예전에는 화면이 라우트(`/api/mathpix` · `/api/grade-exam` …)를 직접 부르고 기다렸다. 이제는
 *   ① 그림을 `<uid>/_jobs/t-<id>-<n>` 에 올리고(요청 본문 4.5MB 한도를 피한다)
 *   ② `/api/figure-jobs`(mode "task")에 넣고 — 보증금은 거기서 걸린다
 *   ③ 끝날 때까지 `GET /api/figure-jobs?task=` 로 묻는다.
 * 넣는 순간 대기열 패널(`FigureJobsPanel`)에 뜨도록 `ai-task:changed` 를 알린다.
 * 서버에 들어간 작업은 이 화면을 떠나도 끝까지 돈다(결과는 받아 갈 화면이 없어질 뿐이다).
 */

export type AiTaskKind =
  | "ocr"
  | "detect"
  | "crop"
  | "figures"
  | "numberBox"
  | "title"
  | "grade"
  | "answerKey"
  | "passageRead"
  | "passageMarks"
  | "typeset"
  | "chat";

export class AiTaskError extends Error {
  constructor(
    message: string,
    /** 넣을 때 받은 HTTP 상태(402 = 토큰 부족 등). 서버에서 돌다 실패했으면 없다. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiTaskError";
  }
}

export type AiTaskResult<T> = {
  result: T;
  /** 실제로 물린 토큰(무제한·BYOK 는 null). */
  chargedTokens: number | null;
  model: string | null;
  note: string | null;
};

/** 패널이 서버 목록을 다시 보게 한다(`FigureJobsProvider` 가 듣는다). */
export const AI_TASK_EVENT = "ai-task:changed";
function announce() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_TASK_EVENT));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 이만큼 넘게 안 끝나면 포기한다(서버는 7분 넘게 도는 작업을 오류로 돌린다). */
const GIVE_UP_MS = 9 * 60 * 1000;

/**
 * **대기열 없이 곧바로 부르는 일들**(서버 `aiTasks.ts` 의 `DIRECT_TASKS` 와 같은 목록 — 서버 모듈은 화면에 못 싣는다).
 * 전부 luna 라 금방 끝난다(사용자 — "luna 는 금방금방 끝나니까 서버에서 돌릴 필요는 없어, 더 빠르게 할 수 있다면").
 * 줄에 넣고 일꾼을 깨우고 1~2초마다 묻는 왕복이 없어 그만큼 빠르다. 대신 이 화면이 결과를 받아야 한다.
 */
const DIRECT_KINDS: readonly AiTaskKind[] = ["crop", "figures", "numberBox", "detect", "title", "grade", "answerKey"];

/** 본문에 그대로 실을 수 있는 그림 크기 합(Vercel 4.5MB 한도 안쪽). 넘으면 미리 올리고 경로만 보낸다. */
const INLINE_LIMIT = 3_300_000;

// ── 곧바로 부른 일들의 목록(대기열 패널이 "luna" 칸에 보여 준다) ──────────────
export type LocalTask = {
  id: string;
  task: AiTaskKind;
  label: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  note?: string | null;
  chargedTokens?: number | null;
};
let localTasks: LocalTask[] = [];
const localListeners = new Set<() => void>();
function setLocal(next: LocalTask[]) {
  localTasks = next;
  localListeners.forEach((fn) => fn());
}
function patchLocal(id: string, patch: Partial<LocalTask>) {
  setLocal(localTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}
export function subscribeLocalTasks(fn: () => void): () => void {
  localListeners.add(fn);
  return () => localListeners.delete(fn);
}
export function getLocalTasks(): LocalTask[] {
  return localTasks;
}
const EMPTY: LocalTask[] = [];
export function getLocalTasksServer(): LocalTask[] {
  return EMPTY;
}
export function dismissLocalTask(id: string) {
  setLocal(localTasks.filter((t) => t.id !== id));
}
/** 끝난 것은 잠시 보여 주고 치운다(성공 1분, 실패 10분). 너무 많이 쌓이지 않게 50개까지. */
function sweepLocal() {
  const now = Date.now();
  const keep = localTasks.filter(
    (t) => t.status === "running" || now - (t.finishedAt ?? now) < (t.status === "error" ? 600_000 : 60_000),
  );
  if (keep.length !== localTasks.length || keep.length > 50) setLocal(keep.slice(-50));
}

async function runDirect<T>(
  task: AiTaskKind,
  opts: { label: string; images?: string[]; params?: Record<string, unknown>; onQueued?: (taskId: string) => void },
): Promise<AiTaskResult<T>> {
  const id = crypto.randomUUID();
  setLocal([...localTasks, { id, task, label: opts.label, status: "running", startedAt: Date.now() }]);
  const uploaded: string[] = [];
  try {
    const images = await Promise.all((opts.images ?? []).map((src) => ensureDataUrl(src)));
    const total = images.reduce((n, x) => n + x.length, 0);
    let payload: { images?: string[]; paths?: string[] } = { images };
    // 크거나, R2 로 바로 올릴 수 있으면 미리 올린다(서버가 읽고 지운다) — 본문에 실으면 그 바이트가 Vercel 함수
    // 전송량(무료 10GB)으로 센다. R2 직접 올리기는 공짜다.
    if (total > INLINE_LIMIT || (images.length > 0 && (await r2DirectReady()))) {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new AiTaskError("로그인이 필요합니다.", 401);
      await Promise.all(
        images.map(async (src, i) => {
          const blob = await (await fetch(src)).blob();
          const type = blob.type || "image/jpeg";
          const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
          const path = `${user.id}/_jobs/d-${id}-${i}.${ext}`;
          const up = await putBlob(supabase, path, blob, type);
          if (!up.ok) throw new AiTaskError(`사진을 올리지 못했어요 (${up.error})`);
          uploaded[i] = path;
        }),
      );
      payload = { paths: uploaded };
    }
    opts.onQueued?.(id);
    const res = await fetch("/api/ai-direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, ...payload, params: opts.params ?? {} }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      result?: unknown;
      error?: string;
      chargedTokens?: number | null;
      model?: string | null;
      note?: string | null;
    };
    if (!res.ok) {
      // 서버가 받기 전에 끊겼으면 올린 것을 치운다(받았으면 서버가 치웠다).
      if (uploaded.length && res.status >= 500) await removeBlobs(uploaded.filter(Boolean)).catch(() => {});
      throw new AiTaskError(json.error ?? `AI 작업이 실패했어요 (HTTP ${res.status}).`, res.status);
    }
    const out: AiTaskResult<T> = {
      result: json.result as T,
      chargedTokens: typeof json.chargedTokens === "number" ? json.chargedTokens : null,
      model: json.model ?? null,
      note: json.note ?? null,
    };
    patchLocal(id, { status: "done", finishedAt: Date.now(), note: out.note, chargedTokens: out.chargedTokens });
    return out;
  } catch (err) {
    const e = err instanceof AiTaskError ? err : new AiTaskError(err instanceof Error ? err.message : String(err));
    patchLocal(id, { status: "error", finishedAt: Date.now(), error: e.message });
    throw e;
  } finally {
    setTimeout(sweepLocal, 61_000);
    setTimeout(sweepLocal, 601_000);
  }
}

export async function runAiTask<T>(
  task: AiTaskKind,
  opts: {
    /** 대기열 패널에 보여 줄 이름. */
    label: string;
    /** 모델에 보낼 그림(데이터 URL 이나 `/api/card/…` 주소). 부르는 쪽이 미리 줄여 둔다. */
    images?: string[];
    params?: Record<string, unknown>;
    /**
     * 서버 줄에 들어간 순간 그 작업 id 를 알려 준다. 결과를 기다리던 화면이 닫혀도 나중에
     * `waitAiTask(id)` 로 받아 갈 수 있게 부르는 쪽이 적어 둔다(수정 창의 sol 조판).
     */
    onQueued?: (taskId: string) => void;
  },
): Promise<AiTaskResult<T>> {
  if (DIRECT_KINDS.includes(task)) return runDirect<T>(task, opts);
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new AiTaskError("로그인이 필요합니다.", 401);

  const id = crypto.randomUUID();
  const uploaded: string[] = [];
  let serverId: string;
  try {
    await Promise.all(
      (opts.images ?? []).map(async (src, i) => {
        const blob = await (await fetch(await ensureDataUrl(src))).blob();
        const type = blob.type || "image/jpeg";
        const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
        const path = `${user.id}/_jobs/t-${id}-${i}.${ext}`;
        const up = await putBlob(supabase, path, blob, type);
        if (!up.ok) throw new AiTaskError(`사진을 올리지 못했어요 (${up.error})`);
        uploaded[i] = path;
      }),
    );
    const res = await fetch("/api/figure-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "task",
        task,
        figureId: id,
        label: opts.label,
        paths: uploaded,
        params: opts.params ?? {},
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { job?: { id: string }; error?: string };
    if (!res.ok || !json.job) throw new AiTaskError(json.error ?? "작업을 넣지 못했어요.", res.status);
    serverId = json.job.id;
  } catch (err) {
    // 서버가 받기 전에 실패했다 — 올린 것을 치운다(받은 뒤라면 서버가 치운다).
    await removeBlobs(uploaded.filter(Boolean)).catch(() => {});
    throw err instanceof AiTaskError ? err : new AiTaskError(err instanceof Error ? err.message : String(err));
  }
  announce();
  opts.onQueued?.(serverId);
  return waitAiTask<T>(serverId);
}

/**
 * 이미 서버 줄에 넣은 짧은 작업이 끝나기를 기다려 결과를 받는다. 끝난 작업이면 곧바로 돌려준다
 * (결과는 그 행의 `state.result` 에 남아 있다). 행이 지워졌으면 404 로 알린다.
 */
export async function waitAiTask<T>(serverId: string): Promise<AiTaskResult<T>> {
  const started = Date.now();
  let first = true;
  let misses = 0;
  try {
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed > GIVE_UP_MS) throw new AiTaskError("서버 작업이 너무 오래 걸려요. 잠시 뒤 다시 해주세요.");
      if (!first) await sleep(elapsed < 20_000 ? 1000 : 2000);
      first = false;
      let body: {
        status?: string;
        error?: string | null;
        result?: unknown;
        chargedTokens?: number | null;
        model?: string | null;
        note?: string | null;
      };
      try {
        const res = await fetch(`/api/figure-jobs?task=${encodeURIComponent(serverId)}`, { cache: "no-store" });
        if (res.status === 401) throw new AiTaskError("로그인이 풀렸어요. 다시 로그인해주세요.", 401);
        if (res.status === 404) throw new AiTaskError("작업을 찾지 못했어요(지워졌을 수 있어요).", 404);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
        misses = 0;
      } catch (err) {
        if (err instanceof AiTaskError) throw err;
        // 잠깐의 네트워크 끊김은 견딘다(서버 작업은 계속 돈다).
        if (++misses > 30) throw new AiTaskError("서버와 연결이 끊겼어요. 결과는 서버에 남아 있을 수 있어요.");
        continue;
      }
      if (body.status === "done") {
        return {
          result: body.result as T,
          chargedTokens: typeof body.chargedTokens === "number" ? body.chargedTokens : null,
          model: body.model ?? null,
          note: body.note ?? null,
        };
      }
      if (body.status === "error") throw new AiTaskError(body.error ?? "서버 작업이 실패했어요.");
    }
  } finally {
    announce();
  }
}
