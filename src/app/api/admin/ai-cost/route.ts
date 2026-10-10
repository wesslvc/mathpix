import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { modelFromWhat } from "@/lib/costLog";
import { MIN_MODEL_USD, OPENAI_CSV_END, usageUsd } from "@/lib/openaiPrices";
import { USD_KRW_RATE } from "@/lib/tokens";

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
  const rawDays = req.nextUrl.searchParams.get("days");
  const asked = Number(rawDays);
  // days=0 → 처음부터 전부(과거 데이터까지). 시간대별은 구간이 너무 많아지므로 30일까지만.
  const all = rawDays !== null && asked === 0;
  const days = all ? 0 : Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : bucket === "hour" ? 2 : 30, 1), bucket === "hour" ? 30 : 3650);
  const since = all ? "2000-01-01T00:00:00Z" : new Date(Date.now() - days * 86_400_000).toISOString();

  const admin = createAdminClient();
  // 장부는 아직 수천 줄이라 전부 읽어 여기서 묶는다(모델별 · 한국 시간 구간별). 모델 칸이 따로 없는 옛 줄도 `what` 으로 모델을 안다.
  const { data, error } = await admin
    .from("ai_cost_log")
    .select("kind, what, model, est_krw, est_usd, created_at")
    .order("created_at", { ascending: false })
    .limit(100000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Raw = { kind: string; what: string; model: string | null; est_krw: number | string; est_usd: number | string; created_at: string };
  const kst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const sinceMs = Date.parse(since);

  type Acc = { krw: number; usd: number; calls: number };
  const zero = (): Acc => ({ krw: 0, usd: 0, calls: 0 });
  const models = new Map<string, { total: Acc; period: Acc; items: Map<string, { total: Acc; period: Acc }> }>();
  const buckets = new Map<string, { label: string; krw: number; calls: number; byModel: Record<string, number> }>();
  let first: number | null = null;

  type Row = { t: number; key: string; itemKey: string; krw: number; usd: number; calls: number };
  const rows: Row[] = [];
  const csvEnd = Date.parse(OPENAI_CSV_END);
  for (const r of (data ?? []) as Raw[]) {
    const t = Date.parse(r.created_at);
    const key = r.model ?? modelFromWhat(r.what) ?? "other";
    // OpenAI 의 CSV 기간 이전 장부 줄은 오차가 있어 버리고 아래 토큰 기준 값을 쓴다.
    if (key.startsWith("gpt") && t < csvEnd) continue;
    rows.push({ t, key, itemKey: `${KIND_LABEL[r.kind] ?? r.kind} · ${r.what}`, krw: Number(r.est_krw) || 0, usd: Number(r.est_usd) || 0, calls: 1 });
  }
  // OpenAI 청구 내역의 토큰 수 × 단가표 (모델·날짜별로 묶는다).
  const { data: usage, error: uErr } = await admin.from("openai_usage_daily").select("day, model, part, kind, tokens").limit(100000);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
  const daily = new Map<string, { t: number; key: string; usd: number }>();
  for (const u of (usage ?? []) as { day: string; model: string; part: string; kind: string; tokens: number | string }[]) {
    const usd = usageUsd(u.model, u.part, u.kind, Number(u.tokens) || 0);
    if (usd === null) continue;
    const k = `${u.day}|${u.model}`;
    const cur = daily.get(k) ?? { t: Date.parse(`${u.day}T12:00:00+09:00`), key: u.model, usd: 0 };
    cur.usd += usd;
    daily.set(k, cur);
  }
  for (const d of daily.values()) {
    rows.push({ t: d.t, key: d.key, itemKey: "청구 내역(토큰 기준)", krw: d.usd * USD_KRW_RATE, usd: d.usd, calls: 0 });
  }
  // 총액 $0.5 미만인 OpenAI 모델은 "기타"로 합친다.
  const sumUsd = new Map<string, number>();
  for (const r of rows) sumUsd.set(r.key, (sumUsd.get(r.key) ?? 0) + r.usd);
  for (const r of rows) {
    if (r.key.startsWith("gpt") && (sumUsd.get(r.key) ?? 0) < MIN_MODEL_USD) r.key = "gpt-etc";
  }

  for (const r of rows) {
    const t = r.t;
    const { krw, usd, key } = r;
    const m = models.get(key) ?? { total: zero(), period: zero(), items: new Map() };
    models.set(key, m);
    const itemKey = r.itemKey;
    const it = m.items.get(itemKey) ?? { total: zero(), period: zero() };
    m.items.set(itemKey, it);
    m.total.krw += krw; m.total.usd += usd; m.total.calls += r.calls;
    it.total.krw += krw; it.total.usd += usd; it.total.calls += r.calls;
    if (first === null || t < first) first = t;
    if (t >= sinceMs) {
      m.period.krw += krw; m.period.usd += usd; m.period.calls += r.calls;
      it.period.krw += krw; it.period.usd += usd; it.period.calls += r.calls;
      // 한국 시간 구간 — sv-SE 는 "2026-10-10 14" 꼴이다.
      const parts = kst.format(new Date(t)); // "YYYY-MM-DD HH"
      const day = parts.slice(0, 10);
      const bkey = bucket === "hour" ? parts : day;
      const label = bucket === "hour" ? `${Number(parts.slice(5, 7))}/${Number(parts.slice(8, 10))} ${parts.slice(11, 13)}시` : `${Number(parts.slice(5, 7))}/${Number(parts.slice(8, 10))}`;
      const b = buckets.get(bkey) ?? { label, krw: 0, calls: 0, byModel: {} };
      buckets.set(bkey, b);
      b.krw += krw; b.calls += r.calls;
      b.byModel[key] = (b.byModel[key] ?? 0) + krw;
    }
  }

  const modelList = [...models.entries()]
    .map(([key, m]) => ({
      key,
      name: key === "other" ? "기타(모델 미상)" : key === "gpt-etc" ? "기타 OpenAI 모델 ($0.5 미만 합산)" : key,
      maker: key.startsWith("claude") ? "Anthropic" : key.startsWith("gpt") ? "OpenAI" : "기타",
      periodKrw: m.period.krw,
      periodUsd: m.period.usd,
      periodCalls: m.period.calls,
      totalKrw: m.total.krw,
      totalUsd: m.total.usd,
      totalCalls: m.total.calls,
      items: [...m.items.entries()]
        .map(([label, v]) => ({ label, periodKrw: v.period.krw, periodCalls: v.period.calls, totalKrw: v.total.krw, totalCalls: v.total.calls }))
        .sort((a, b) => b.totalKrw - a.totalKrw),
    }))
    .sort((a, b) => b.totalKrw - a.totalKrw);
  const sum = (f: (m: (typeof modelList)[number]) => number) => modelList.reduce((a, m) => a + f(m), 0);

  return NextResponse.json({
    bucket,
    days,
    models: modelList,
    buckets: [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([, b]) => b),
    periodKrw: sum((m) => m.periodKrw),
    periodUsd: sum((m) => m.periodUsd),
    totalKrw: sum((m) => m.totalKrw),
    totalUsd: sum((m) => m.totalUsd),
    since: first === null ? null : kst.format(new Date(first)).slice(0, 10),
  });
}

/** 장부의 갈래 이름을 화면 글자로. */
const KIND_LABEL: Record<string, string> = {
  problem: "문제",
  figure: "그림",
  passage: "국어 지문",
  grade: "채점",
};
