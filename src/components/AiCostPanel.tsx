"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ModelBadge, type ModelKey } from "@/components/ModelBadge";

/**
 * AI 원가 누적 — **무제한 계정에게만** 보인다(서버가 `requireFontAdmin` 으로 막는다).
 *
 * 작업 목록의 원가는 작업을 치우면 사라진다. 여기는 `ai_cost_log`(작업과 떼어 놓은 추가 전용
 * 장부)를 읽으므로 **실수로 지워도 합계가 줄지 않는다.** 한국 시간 기준, 공표 단가로 계산한
 * 추정치다(최종 청구액은 OpenAI 대시보드).
 */
type Item = { label: string; periodKrw: number; periodCalls: number; totalKrw: number; totalCalls: number };
type ModelRow = {
  key: string;
  name: string;
  maker: string;
  periodKrw: number;
  periodUsd: number;
  periodCalls: number;
  totalKrw: number;
  totalUsd: number;
  totalCalls: number;
  items: Item[];
};
type Data = {
  bucket: "hour" | "day";
  days: number;
  models: ModelRow[];
  buckets: { label: string; krw: number; calls: number; byModel: Record<string, number> }[];
  periodKrw: number;
  periodUsd: number;
  totalKrw: number;
  totalUsd: number;
  since: string | null;
};

/** 로고별 범주(만든 곳)와 막대 색. 모델 이름은 서버가 정식 명칭으로 준다. */
const MAKER_ORDER = ["Anthropic", "OpenAI", "기타"];
// 모델 이름(서버가 장부의 정식 이름을 그대로 준다)으로 색·로고를 고른다.
const colorOf = (name: string) =>
  name.includes("haiku") ? "bg-orange-400/80" : name.includes("luna") ? "bg-sky-400/80" : name.includes("sol") ? "bg-blue-600/80" : name.includes("image") ? "bg-emerald-500/80" : "bg-slate-400/80";
const logoOf = (name: string): ModelKey | undefined =>
  name.includes("haiku") ? "haiku" : name.includes("luna") ? "luna" : name.includes("sol") ? "sol" : name.includes("image") ? "sunburst" : undefined;

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const usd = (n: number) => `$${n.toFixed(2)}`;

export default function AiCostPanel() {
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  const [range, setRange] = useState<"default" | "all">("all");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (b: "hour" | "day", r: "default" | "all") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ai-cost?bucket=${b}${r === "all" ? "&days=0" : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "불러오지 못했어요.");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했어요.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(bucket, range);
  }, [bucket, range, load]);

  const max = Math.max(1, ...(data?.buckets ?? []).map((b) => b.krw));
  const makers = MAKER_ORDER.map((m) => ({ maker: m, models: (data?.models ?? []).filter((x) => x.maker === m) })).filter((g) => g.models.length > 0);

  return (
    <section className={cn(cardClass, "flex flex-col gap-3 p-4")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink">AI 비용 누적</h2>
          <p className="text-xs text-slate-500">무제한 계정에만 보여요 · 모델별 · 작업을 지워도 줄지 않아요</p>
        </div>
        <div className="flex items-center gap-1">
          {(["hour", "day"] as const).map((b) => (
            <Button
              key={b}
              size="xs"
              variant={bucket === b ? "dark" : "outline"}
              onClick={() => setBucket(b)}
            >
              {b === "hour" ? "시간대별" : "날짜별"}
            </Button>
          ))}
          <Button size="xs" variant={range === "all" ? "dark" : "outline"} onClick={() => setRange(range === "all" ? "default" : "all")}>
            {range === "all" ? "전체 기간" : "최근만"}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => load(bucket, range)}>
            새로고침
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">
                {data.days === 0 ? "전체 기간" : `최근 ${data.days}일`} {data.bucket === "hour" ? "(시간대별 보기)" : ""}
              </div>
              <div className="text-lg font-semibold text-ink">{won(data.periodKrw)}</div>
              <div className="text-xs text-slate-400">{usd(data.periodUsd)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">
                전체 누적{data.since ? ` (${data.since.slice(5).replace("-", "/")}부터)` : ""}
              </div>
              <div className="text-lg font-semibold text-ink">{won(data.totalKrw)}</div>
              <div className="text-xs text-slate-400">{usd(data.totalUsd)}</div>
            </div>
          </div>

          {data.buckets.length === 0 ? (
            <p className="py-3 text-center text-sm text-slate-400">이 기간에는 기록이 없어요.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.buckets.map((b) => (
                <li key={b.label} className="flex items-center gap-2 text-sm">
                  <span className="w-16 shrink-0 tabular-nums text-slate-500">{b.label}</span>
                  <span className="flex h-4 flex-1 overflow-hidden rounded bg-slate-100">
                    {data.models
                      .filter((m) => b.byModel[m.key])
                      .map((m) => (
                        <span
                          key={m.key}
                          title={`${m.name} ${won(b.byModel[m.key])}`}
                          className={cn("h-full", colorOf(m.key))}
                          style={{ width: `${(b.byModel[m.key] / max) * 100}%` }}
                        />
                      ))}
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums text-ink">{won(b.krw)}</span>
                  <span className="hidden w-12 shrink-0 text-right text-xs text-slate-400 sm:inline">{b.calls}회</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-3">
            {makers.map((g) => (
              <div key={g.maker} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                  {logoOf(g.models[0].key) && <ModelBadge model={logoOf(g.models[0].key)!} label={false} />}
                  {g.maker}
                  <span className="font-normal tabular-nums text-slate-400">
                    · 기간 {won(g.models.reduce((a, m) => a + m.periodKrw, 0))} · 누적 {won(g.models.reduce((a, m) => a + m.totalKrw, 0))}
                  </span>
                </div>
                {g.models.map((m) => (
                  <details key={m.key} open className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", colorOf(m.key))} />
                      <span className="font-medium text-ink">{m.name}</span>
                      <span className="ml-auto tabular-nums text-ink">
                        기간 {won(m.periodKrw)} {m.periodCalls > 0 && <span className="text-xs text-slate-400">· {m.periodCalls}회</span>}
                      </span>
                      <span className="w-full text-right text-xs tabular-nums text-slate-500 sm:w-auto">
                        누적 {won(m.totalKrw)} ({usd(m.totalUsd)}) {m.totalCalls > 0 ? `· ${m.totalCalls.toLocaleString()}회` : ""}
                      </span>
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1 border-t border-slate-100 pt-2">
                      {m.items.map((r) => (
                        <li key={r.label} className="flex justify-between gap-2">
                          <span className="text-slate-600">{r.label}</span>
                          <span className="tabular-nums text-ink">
                            {won(r.periodKrw)} <span className="text-xs text-slate-400">· 누적 {won(r.totalKrw)} {r.totalCalls > 0 ? `· ${r.totalCalls}회` : ""}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            공표 단가로 계산한 추정치예요(한국 시간 기준). 최종 청구액은 OpenAI 대시보드를 보세요.
            BYOK 계정 작업은 본인 키라 안 넣어요.
          </p>
        </>
      )}
    </section>
  );
}
