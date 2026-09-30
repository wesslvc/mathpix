import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * **AI 원가 누적**(무제한 계정 전용 — `requireFontAdmin`). `ai_cost_log` 는 작업을 치워도
 * 남는 추가 전용 장부라 여기서 본 합계는 사용자가 작업을 지워도 줄지 않는다.
 *
 * `?bucket=hour|day`(기본 day) · `?days=N`(기본: 시간대별 2일, 날짜별 30일). 한국 시간 기준.
 */
export async function GET(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "서비스 키가 설정되지 않았습니다." }, { status: 503 });
  }

  const bucket = req.nextUrl.searchParams.get("bucket") === "hour" ? "hour" : "day";
  const asked = Number(req.nextUrl.searchParams.get("days"));
  const days = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : bucket === "hour" ? 2 : 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const admin = createAdminClient();
  const [rows, total, kinds] = await Promise.all([
    admin.rpc("ai_cost_summary", { p_since: since, p_bucket: bucket }),
    admin.rpc("ai_cost_summary", { p_since: "2000-01-01T00:00:00Z", p_bucket: "day" }),
    admin
      .from("ai_cost_log")
      .select("kind, what, est_krw")
      .gte("created_at", since)
      .limit(50000),
  ]);
  if (rows.error) {
    return NextResponse.json({ error: rows.error.message }, { status: 500 });
  }

  type Row = { bucket: string; krw: number | string; usd: number | string; calls: number | string };
  const toRow = (r: Row) => ({
    bucket: r.bucket,
    krw: Number(r.krw),
    usd: Number(r.usd),
    calls: Number(r.calls),
  });
  const buckets = ((rows.data ?? []) as Row[]).map(toRow);
  const all = ((total.data ?? []) as Row[]).map(toRow);

  // 이 기간 합계를 종류(그림·sol 검수 …)별로도 쪼갠다.
  const byWhat = new Map<string, { krw: number; calls: number }>();
  for (const r of (kinds.data ?? []) as { kind: string; what: string; est_krw: number | string }[]) {
    const key = `${r.kind} · ${r.what}`;
    const cur = byWhat.get(key) ?? { krw: 0, calls: 0 };
    cur.krw += Number(r.est_krw);
    cur.calls += 1;
    byWhat.set(key, cur);
  }

  return NextResponse.json({
    bucket,
    days,
    buckets,
    periodKrw: buckets.reduce((a, b) => a + b.krw, 0),
    periodUsd: buckets.reduce((a, b) => a + b.usd, 0),
    totalKrw: all.reduce((a, b) => a + b.krw, 0),
    totalUsd: all.reduce((a, b) => a + b.usd, 0),
    since: all.length ? all[all.length - 1].bucket : null,
    byWhat: [...byWhat.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.krw - a.krw),
  });
}
