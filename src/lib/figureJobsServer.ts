// 서버 큐(figure_jobs)를 다루는 라우트들이 같이 쓰는 것. **서버 전용.**
//
// 큐 자체의 설명은 `supabase/migrations/0029_figure_jobs.sql` 머리말에 있다.

import type { SupabaseClient } from "@supabase/supabase-js";

/** 화면으로 내려보내는 칸만. 입력 경로 같은 속사정은 안 보낸다. */
export const JOB_COLUMNS =
  "id, figure_id, problem_key, problem_id, label, mode, korean, instruction, status, charged, charged_tokens, usage, model, result_path, applied_at, error, created_at, finished_at, stage, note";

export type FigureJobRow = {
  id: string;
  figure_id: string;
  problem_key: string;
  problem_id: string | null;
  label: string;
  mode: "figure" | "problem" | "passage" | "task";
  korean: boolean;
  instruction: string | null;
  status: "pending" | "running" | "done" | "error";
  charged: boolean;
  charged_tokens: number;
  usage: Record<string, number> | null;
  model: string | null;
  result_path: string | null;
  applied_at: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** 지문 작업의 지금 단계(read / marks / figure:N / done). 다른 작업은 null. */
  stage: string | null;
  /** 사람이 읽는 한 줄(지문 작업). */
  note: string | null;
};

let cachedToken: string | null = null;

/**
 * 일꾼 라우트를 부를 때 쓰는 비밀값. DB(Vault) 안에서 만들어져 거기에만 있다 —
 * 환경변수로 따로 넣을 것이 없다. 인스턴스마다 한 번만 읽는다.
 */
export async function workerToken(admin: SupabaseClient): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const { data, error } = await admin.rpc("figure_worker_token");
  if (error || typeof data !== "string" || data.length < 16) {
    console.error("[figure-jobs] 일꾼 토큰을 못 읽음:", error?.message);
    return null;
  }
  cachedToken = data;
  return data;
}

/**
 * 일꾼을 깨운다. **응답을 기다리지 않는다** — 일꾼은 몇 분씩 돌 수 있다.
 * 요청이 서버에 닿을 만큼만 기다리고 끊는다. 끊어도 저쪽 함수는 끝까지 돈다.
 * 설령 이 호출이 유실돼도 pg_cron 이 1분 안에 다시 깨운다.
 */
export async function kickWorker(
  admin: SupabaseClient,
  base: string,
  preferUser?: string,
): Promise<void> {
  const token = await workerToken(admin);
  if (!token) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    await fetch(`${base}/api/figure-jobs/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": token },
      body: JSON.stringify({ preferUser }),
      signal: ctrl.signal,
    });
  } catch {
    // 끊은 것이 정상이다(위 주석). 진짜 실패여도 pg_cron 이 받친다.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 동시에 돌리는 작업 수. 무제한 계정은 한 번에 이만큼(사용자 — "무제한 계정은 10개씩"), 나머지는 1개.
 * 전체 합계에도 상한을 둔다 — OpenAI **Tier 2 는 이미지 분당 20장(IPM)·TPM 25만**이라 넘치면 429 가 난다
 * (`runFigureGeneration` 이 429 는 잠깐 기다렸다 다시 보내지만 애초에 덜 몰리게 한다). 문제 하나의 그리기는
 * 35~45초, 검수 15초라 열 개가 돌아도 이미지는 분당 10장 안팎이다. 계정 티어가 오르면 환경변수로 올린다.
 */
export const UNLIMITED_CONCURRENCY = envInt("FIGURE_UNLIMITED_CONCURRENCY", 10);
export const GLOBAL_CONCURRENCY = envInt("FIGURE_GLOBAL_CONCURRENCY", 12);
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
}
