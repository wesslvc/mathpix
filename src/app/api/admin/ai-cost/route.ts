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
  // 장부는 아직 수천 줄이라 전부 읽어 여기서 묶는다(모델별 · 한국 시간 구간별). 모델 칸이 따로 없는 옛 줄도 `what` 으로 모델을 안다.
  const { data, error } = await admin
    .from("ai_cost_log")
    .select("kind, what, est_krw, est_usd, created_at")
    .order("created_at", { ascending: false })
    .limit(100000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Raw = { kind: string; what: string; est_krw: number | string; est_usd: number | string; created_at: string };
  const kst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const sinceMs = Date.parse(since);

  type Acc = { krw: number; usd: number; calls: number };
  const zero = (): Acc => ({ krw: 0, usd: 0, calls: 0 });
  const models = new Map<string, { total: Acc; period: Acc; items: Map<string, { total: Acc; period: Acc }> }>();
  const buckets = new Map<string, { label: string; krw: number; calls: number; byModel: Record<string, number> }>();
  let first: number | null = null;

  for (const r of (data ?? []) as Raw[]) {
    const t = Date.parse(r.created_at);
    const krw = Number(r.est_krw) || 0;
    const usd = Number(r.est_usd) || 0;
    const key = modelOf(r.what);
    const m = models.get(key) ?? { total: zero(), period: zero(), items: new Map() };
    models.set(key, m);
    const itemKey = `${KIND_LABEL[r.kind] ?? r.kind} · ${r.what}`;
    const it = m.items.get(itemKey) ?? { total: zero(), period: zero() };
    m.items.set(itemKey, it);
    m.total.krw += krw; m.total.usd += usd; m.total.calls++;
    it.total.krw += krw; it.total.usd += usd; it.total.calls++;
    if (first === null || t < first) first = t;
    if (t >= sinceMs) {
      m.period.krw += krw; m.period.usd += usd; m.period.calls++;
      it.period.krw += krw; it.period.usd += usd; it.period.calls++;
      // 한국 시간 구간 — sv-SE 는 "2026-10-10 14" 꼴이다.
      const parts = kst.format(new Date(t)); // "YYYY-MM-DD HH"
      const day = parts.slice(0, 10);
      const bkey = bucket === "hour" ? parts : day;
      const label = bucket === "hour" ? `${Number(parts.slice(5, 7))}/${Number(parts.slice(8, 10))} ${parts.slice(11, 13)}시` : `${Number(parts.slice(5, 7))}/${Number(parts.slice(8, 10))}`;
      const b = buckets.get(bkey) ?? { label, krw: 0, calls: 0, byModel: {} };
      buckets.set(bkey, b);
      b.krw += krw; b.calls++;
      b.byModel[key] = (b.byModel[key] ?? 0) + krw;
    }
  }

  const modelList = [...models.entries()]
    .map(([key, m]) => ({
      key,
      name: MODEL_NAME[key] ?? key,
      maker: MODEL_MAKER[key] ?? "기타",
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

/**
 * 장부 줄의 `what` 으로 모델을 안다. 장부에 모델 칸이 없던 때부터 쌓였으므로 옛 줄도 같은 규칙으로 묶인다.
 * **sol 은 2026-09-30 부터 gpt-6.1-sol 이다** — 그 전 줄은 gpt-6-sol 이었지만 장부만으로는 갈라낼 수 없어 한 칸에 묶는다.
 */
function modelOf(what: string): string {
  if (what.startsWith("하이쿠")) return "haiku";
  if (what.startsWith("그림")) return "sunburst";
  if (what.startsWith("sol ") || what === "지문 읽기" || what === "서식 검수" || what.startsWith("지문 읽기(") || what.startsWith("서식 검수(")) return "sol";
  if (what.startsWith("luna ") || what === "자동채점" || what === "답지 읽기" || what === "지문 제목 짓기") return "luna";
  return "other"; // 예: "지면 자리 찾기" — 하이쿠·Gemini·luna 중 어느 것이 답했는지 장부에 안 남았다.
}

const MODEL_NAME: Record<string, string> = {
  haiku: "claude-haiku-5.5",
  luna: "gpt-6-luna",
  sol: "gpt-6.1-sol",
  sunburst: "gpt-image-2.5-sunburst",
  other: "기타(모델 미상)",
};
const MODEL_MAKER: Record<string, string> = { haiku: "Anthropic", luna: "OpenAI", sol: "OpenAI", sunburst: "OpenAI", other: "기타" };

/** 장부의 갈래 이름을 화면 글자로. */
const KIND_LABEL: Record<string, string> = {
  problem: "문제",
  figure: "그림",
  passage: "국어 지문",
  grade: "채점",
};
