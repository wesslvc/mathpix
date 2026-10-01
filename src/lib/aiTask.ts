import { createClient } from "@/lib/supabase/client";
import { putBlob, removeBlobs } from "./blobClient";
import { ensureDataUrl } from "./figureImage";

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

export async function runAiTask<T>(
  task: AiTaskKind,
  opts: {
    /** 대기열 패널에 보여 줄 이름. */
    label: string;
    /** 모델에 보낼 그림(데이터 URL 이나 `/api/card/…` 주소). 부르는 쪽이 미리 줄여 둔다. */
    images?: string[];
    params?: Record<string, unknown>;
  },
): Promise<AiTaskResult<T>> {
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

  const started = Date.now();
  let misses = 0;
  try {
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed > GIVE_UP_MS) throw new AiTaskError("서버 작업이 너무 오래 걸려요. 잠시 뒤 다시 해주세요.");
      await sleep(elapsed < 20_000 ? 1000 : 2000);
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
