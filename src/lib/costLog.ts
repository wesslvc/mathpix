import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI 원가 장부에 한 줄 적는다(`ai_cost_log`, 마이그레이션 0031).
 *
 * 작업(`figure_jobs`)과 **떼어 놓은** 추가 전용 기록이다 — 사용자가 작업을 치워도 원가가
 * 남아야 "시간대별로 누적해서" 볼 수 있다. 장부를 못 적어도 작업은 멈추지 않는다(경고만).
 */
export async function logAiCost(
  admin: SupabaseClient,
  row: {
    userId: string;
    jobId: string;
    kind: "problem" | "figure" | "passage";
    what: string;
    krw: number;
    usd?: number;
    krwRate?: number;
  },
): Promise<void> {
  if (!(row.krw > 0)) return;
  const usd = row.usd ?? (row.krwRate && row.krwRate > 0 ? row.krw / row.krwRate : 0);
  try {
    const { error } = await admin.from("ai_cost_log").insert({
      user_id: row.userId,
      job_id: row.jobId,
      kind: row.kind,
      what: row.what,
      est_krw: row.krw,
      est_usd: usd,
    });
    if (error) console.warn("[costLog] 장부 기록 실패:", error.message);
  } catch (err) {
    console.warn("[costLog] 장부 기록 실패:", err instanceof Error ? err.message : err);
  }
}
