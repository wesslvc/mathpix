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
  mode: "figure" | "problem" | "passage";
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
