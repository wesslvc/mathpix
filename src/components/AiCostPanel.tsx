"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * AI 원가 누적 — **무제한 계정에게만** 보인다(서버가 `requireFontAdmin` 으로 막는다).
 *
 * 작업 목록의 원가는 작업을 치우면 사라진다. 여기는 `ai_cost_log`(작업과 떼어 놓은 추가 전용
 * 장부)를 읽으므로 **실수로 지워도 합계가 줄지 않는다.** 한국 시간 기준, 공표 단가로 계산한
 * 추정치다(최종 청구액은 OpenAI 대시보드).
 */
type Data = {
  bucket: "hour" | "day";
  days: number;
  buckets: { bucket: string; krw: number; usd: number; calls: number }[];
  periodKrw: number;
  periodUsd: number;
  totalKrw: number;
  totalUsd: number;
  since: string | null;
  byWhat: { label: string; krw: number; calls: number }[];
};

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const usd = (n: number) => `$${n.toFixed(2)}`;

function label(iso: string, bucket: "hour" | "day") {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    ...(bucket === "hour" ? { hour: "2-digit", hour12: false } : {}),
  }).format(d);
  return bucket === "hour" ? `${f}시` : f;
}

export default function AiCostPanel() {
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (b: "hour" | "day") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ai-cost?bucket=${b}`, { cache: "no-store" });
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
    void load(bucket);
  }, [bucket, load]);

  const max = Math.max(1, ...(data?.buckets ?? []).map((b) => b.krw));

  return (
    <section className={cn(cardClass, "flex flex-col gap-3 p-4")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink">AI 비용 누적</h2>
          <p className="text-xs text-slate-500">무제한 계정에만 보여요 · 작업을 지워도 줄지 않아요</p>
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
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => load(bucket)}>
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
                최근 {data.days}일 {data.bucket === "hour" ? "(시간대별 보기)" : ""}
              </div>
              <div className="text-lg font-semibold text-ink">{won(data.periodKrw)}</div>
              <div className="text-xs text-slate-400">{usd(data.periodUsd)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">
                전체 누적{data.since ? ` (${label(data.since, "day")}부터)` : ""}
              </div>
              <div className="text-lg font-semibold text-ink">{won(data.totalKrw)}</div>
              <div className="text-xs text-slate-400">{usd(data.totalUsd)}</div>
            </div>
          </div>

          {data.buckets.length === 0 ? (
            <p className="py-3 text-center text-sm text-slate-400">
              아직 기록이 없어요. 이 기능이 배포된 뒤의 AI 작업부터 쌓여요.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.buckets.map((b) => (
                <li key={b.bucket} className="flex items-center gap-2 text-sm">
                  <span className="w-16 shrink-0 tabular-nums text-slate-500">
                    {label(b.bucket, data.bucket)}
                  </span>
                  <span className="relative h-4 flex-1 overflow-hidden rounded bg-slate-100">
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-blue-500/70"
                      style={{ width: `${Math.max(2, (b.krw / max) * 100)}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums text-ink">{won(b.krw)}</span>
                  <span className="hidden w-12 shrink-0 text-right text-xs text-slate-400 sm:inline">
                    {b.calls}회
                  </span>
                </li>
              ))}
            </ul>
          )}

          {data.byWhat.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-500">종류별로 보기</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {data.byWhat.map((r) => (
                  <li key={r.label} className="flex justify-between gap-2">
                    <span className="text-slate-600">{r.label}</span>
                    <span className="tabular-nums text-ink">
                      {won(r.krw)} <span className="text-xs text-slate-400">· {r.calls}회</span>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-slate-400">
            공표 단가로 계산한 추정치예요(한국 시간 기준). 최종 청구액은 OpenAI 대시보드를 보세요.
            BYOK 계정 작업은 본인 키라 안 넣어요.
          </p>
        </>
      )}
    </section>
  );
}
