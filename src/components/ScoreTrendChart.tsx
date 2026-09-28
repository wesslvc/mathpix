"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TrendMetric, TrendPoint, TrendSeries } from "@/lib/scoreTrend";
import { officialExamOn } from "@/lib/officialExams";

/**
 * 성적 추세 — **과목별 요약 카드 + 고른 과목의 큰 그래프**.
 *
 * 예전에는 모든 과목을 한 그래프(viewBox 720)에 겹쳐 그렸는데 보기가 너무
 * 불편하다는 말을 들었다(사용자 — "보기가 너무 불편해"). 원인이 셋이었다:
 * ① viewBox 를 화면 폭에 늘려 그려서 휴대폰에서는 글자가 9px → 4~5px 로
 *    줄었다 — 날짜·눈금이 사실상 안 읽혔다. 이제 **실제 폭을 재서 그 폭으로**
 *    그린다(`useWidth`) — 글자 크기가 화면과 상관없이 늘 같다.
 * ② 과목 여럿을 한 축에 겹치니 선이 엉키고, 탐구(50점 만점)가 100점 축에서
 *    늘 반쯤 아래에 깔려 **떨어진 것처럼** 보였다. 이제 기본은 과목 하나씩
 *    보고, 겹쳐 볼 때는 **만점 대비 %** 로 맞춘다(축 이름에 그렇게 적는다).
 * ③ 점수를 보려면 점 위에 마우스를 올려 `<title>` 을 기다려야 했다(휴대폰에서는
 *    아예 안 된다). 이제 점마다 값을 적고, 누르면 그날의 기록이 카드로 뜬다
 *    (시험 이름·오답 수·"자세히" 링크).
 *
 * **새 차트 라이브러리를 넣지 않는다** — 선 몇 개에 의존성을 늘릴 이유가 없다.
 */

/** 과목마다 다른 색. 첫 색은 브랜드 파랑이다. */
const PALETTE = ["#2f74b8", "#0f9f6e", "#d9822b", "#7c5cc4", "#d64545", "#1b98b0", "#6b9e2a", "#c9477f"];

type Colored = TrendSeries & { color: string };
type Selection = string | "all";

function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}.${Number(d)}`;
}

function valueText(metric: TrendMetric, p: TrendPoint): string {
  if (metric === "grade") return `${p.value}등급`;
  return p.hasScore ? `${p.value}점` : `${p.value}%`;
}

/** 두 점 사이 변화. 좋아졌으면 good. 등급은 숫자가 작을수록 좋다. */
function deltaOf(metric: TrendMetric, prev: TrendPoint, last: TrendPoint) {
  if (metric === "grade") {
    const d = prev.value - last.value;
    return { d, text: `${Math.abs(d)}등급`, good: d > 0 };
  }
  // 둘 다 점수면 점수 차, 아니면(정답률이 섞였으면) 만점 대비 %p 차.
  const both = prev.hasScore && last.hasScore;
  const d = both ? last.value - prev.value : Math.round((last.pct - prev.pct) * 10) / 10;
  return { d, text: both ? `${Math.abs(d)}점` : `${Math.abs(d)}%p`, good: d > 0 };
}

function Delta({ metric, points }: { metric: TrendMetric; points: TrendPoint[] }) {
  if (points.length < 2) return null;
  const { d, text, good } = deltaOf(metric, points[points.length - 2], points[points.length - 1]);
  if (d === 0) {
    return <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">유지</span>;
  }
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
        good ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
      }`}
    >
      {good ? "▲" : "▼"} {text}
    </span>
  );
}

/** 그래프를 실제 픽셀 폭으로 그리기 위해 폭을 잰다. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Sparkline({ points, color, metric }: { points: TrendPoint[]; color: string; metric: TrendMetric }) {
  if (points.length < 2) return <div className="h-7" />;
  const ys = points.map((p) => (metric === "grade" ? -p.value : p.pct));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = points
    .map((_, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 26 - ((ys[i] - lo) / span) * 22;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function SummaryCard({
  s,
  metric,
  selected,
  onSelect,
}: {
  s: Colored;
  metric: TrendMetric;
  selected: boolean;
  onSelect: () => void;
}) {
  const last = s.points[s.points.length - 1];
  const best = s.points.reduce((a, p) =>
    metric === "grade" ? (p.value < a.value ? p : a) : p.pct > a.pct ? p : a,
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col gap-1 rounded-2xl border bg-white p-3 text-left transition-all ${
        selected
          ? "border-transparent shadow-sm ring-2"
          : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
      }`}
      style={selected ? ({ "--tw-ring-color": s.color } as React.CSSProperties) : undefined}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
        <span className="truncate">{s.label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="text-2xl font-bold tabular-nums tracking-tight text-ink">
          {last.value}
        </span>
        <span className="text-xs text-slate-400">
          {metric === "grade" ? "등급" : last.hasScore ? `/ ${s.max}` : "%"}
        </span>
        <Delta metric={metric} points={s.points} />
      </span>
      <Sparkline points={s.points} color={s.color} metric={metric} />
      <span className="text-[11px] text-slate-400">
        {s.points.length}회 · 최고 {valueText(metric, best)}
      </span>
    </button>
  );
}

/** 눈금 간격을 보기 좋은 값으로. */
function niceStep(span: number, target: number): number {
  const raw = span / target;
  for (const s of [1, 2, 5, 10, 20, 25, 50]) if (s >= raw) return s;
  return 50;
}

function TrendChart({
  series,
  metric,
  mode,
}: {
  series: Colored[];
  metric: TrendMetric;
  /** single: 한 과목(눈금을 그 과목 점수로) · all: 겹쳐 보기(만점 대비 %). */
  mode: "single" | "all";
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);

  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const p of s.points) set.add(p.takenAt);
    return [...set].sort();
  }, [series]);

  // 과목이나 보기가 바뀌면 떠 있던 카드를 닫는다(그 날짜가 없을 수 있다).
  useEffect(() => setHover(null), [series, metric]);

  if (dates.length === 0) return null;

  const narrow = width < 520;
  const height = narrow ? 230 : 290;
  const padL = 40;
  const padR = 18;
  const padT = 30;
  const padB = 30;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const isGrade = metric === "grade";
  const one = series.length === 1 ? series[0] : null;
  // 한 과목이고 점수가 있으면 눈금을 그 과목 점수로(탐구 0~50) 적는다.
  const rawTicks = !isGrade && mode === "single" && !!one && one.points.some((p) => p.hasScore);

  // ── 세로 범위: 데이터에 맞춰 조금 당겨 본다(90점대끼리의 차이가 보이게) ──
  const all = series.flatMap((s) => s.points);
  let lo: number;
  let hi: number;
  let ticks: number[];
  if (isGrade) {
    lo = 1;
    hi = Math.min(9, Math.max(5, Math.max(...all.map((p) => p.value)) + 1));
    ticks = [];
    const step = hi - lo > 5 ? 2 : 1;
    for (let g = lo; g <= hi; g += step) ticks.push(g);
  } else {
    const minPct = Math.min(...all.map((p) => p.pct));
    const step = niceStep(100 - Math.max(0, minPct - 10), narrow ? 3 : 4);
    lo = Math.max(0, Math.floor((minPct - 8) / step) * step);
    hi = 100;
    ticks = [];
    for (let v = lo; v <= hi + 0.01; v += step) ticks.push(Math.round(v));
    if (ticks[ticks.length - 1] !== 100) ticks.push(100);
  }

  const xOf = (i: number) => (dates.length === 1 ? padL + innerW / 2 : padL + (innerW * i) / (dates.length - 1));
  const yOf = (v: number) =>
    isGrade ? padT + (innerH * (v - lo)) / (hi - lo) : padT + innerH * (1 - (v - lo) / (hi - lo));
  const yOfPoint = (p: TrendPoint) => yOf(isGrade ? p.value : p.pct);
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  const tickLabel = (v: number) =>
    isGrade ? `${v}` : rawTicks && one ? `${Math.round((v * one.max) / 100)}` : `${v}%`;

  // 날짜 글자는 서로 안 겹칠 만큼만 적는다(한 글자 칸 약 36px).
  const every = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor(innerW / 44))));

  // 점마다 값을 적을지 — 점이 너무 빽빽하면 마지막·최고만.
  const labelAll = mode === "single" && dates.length <= Math.floor(innerW / 38);

  function pick(clientX: number) {
    const el = wrapRef.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    let best = 0;
    let bestD = Infinity;
    dates.forEach((_, i) => {
      const d = Math.abs(xOf(i) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  }

  const hoverDate = hover != null ? dates[hover] : null;
  const hoverRows =
    hoverDate == null
      ? []
      : series.flatMap((s) =>
          s.points.filter((p) => p.takenAt === hoverDate).map((p) => ({ s, p })),
        );
  const hoverX = hover != null ? xOf(hover) : 0;

  const gradId = `trend-fill-${one?.key.replace(/[^a-z0-9]/gi, "") ?? "all"}`;

  return (
    <div ref={wrapRef} className="select-none">
      <svg
        width={width}
        height={height}
        className="block touch-pan-y"
        role="img"
        aria-label="성적 추세 그래프"
        onPointerMove={(e) => e.pointerType === "mouse" && pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
      >
        {one && (
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={one.color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={one.color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}

        {/* 눈금 */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={yOf(t)} y2={yOf(t)} stroke="#eef1f5" strokeWidth={1} />
            <text x={padL - 8} y={yOf(t) + 4} fontSize={11} fill="#94a3b8" textAnchor="end" className="tabular-nums">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        {/* 정식 시험(6·9모·수능) 안내선 — 선·점 뒤에 깐다. */}
        {dates.map((d, i) => {
          const name = officialExamOn(d);
          if (!name) return null;
          const x = xOf(i);
          const w = name.length * 11 + 12;
          const left = Math.max(padL - 4, Math.min(width - padR - w + 4, x - w / 2));
          return (
            <g key={`o-${d}`}>
              <line x1={x} x2={x} y1={padT - 6} y2={height - padB} stroke="#c7d2e0" strokeWidth={1} strokeDasharray="3 3" />
              <rect x={left} y={padT - 22} width={w} height={17} rx={8.5} fill="#eef4fb" />
              <text x={left + w / 2} y={padT - 9.5} fontSize={10.5} fontWeight={700} fill="#2f74b8" textAnchor="middle">
                {name}
              </text>
            </g>
          );
        })}

        {/* 고른 날짜 안내선 */}
        {hover != null && (
          <line x1={hoverX} x2={hoverX} y1={padT} y2={height - padB} stroke="#94a3b8" strokeWidth={1} />
        )}

        {series.map((s) => {
          const pts = s.points.map((p) => ({ p, x: xOf(dateIndex.get(p.takenAt)!), y: yOfPoint(p) }));
          const line = pts.map((q, i) => `${i === 0 ? "M" : "L"}${q.x},${q.y}`).join(" ");
          const area =
            one && pts.length > 1
              ? `${line} L${pts[pts.length - 1].x},${height - padB} L${pts[0].x},${height - padB} Z`
              : null;
          const bestIdx = pts.reduce(
            (b, q, i) => (isGrade ? (q.p.value < pts[b].p.value ? i : b) : q.p.pct > pts[b].p.pct ? i : b),
            0,
          );
          return (
            <g key={s.key}>
              {area && <path d={area} fill={`url(#${gradId})`} />}
              <path d={line} fill="none" stroke={s.color} strokeWidth={one ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((q, i) => {
                const official = officialExamOn(q.p.takenAt);
                const on = hover != null && dates[hover] === q.p.takenAt;
                const showLabel = labelAll || i === pts.length - 1 || (mode === "single" && i === bestIdx);
                return (
                  <g key={q.p.id}>
                    <circle
                      cx={q.x}
                      cy={q.y}
                      r={on ? 6 : official ? 5.5 : 4}
                      fill={q.p.hasScore ? s.color : "#ffffff"}
                      stroke={official ? "#ffffff" : s.color}
                      strokeWidth={official ? 2 : 2}
                    />
                    {official && <circle cx={q.x} cy={q.y} r={(on ? 6 : 5.5) + 2.5} fill="none" stroke={s.color} strokeWidth={1.5} />}
                    {showLabel && mode === "single" && (
                      <text
                        x={q.x}
                        y={q.y - 11}
                        fontSize={11.5}
                        fontWeight={700}
                        fill={s.color}
                        textAnchor={i === 0 && dates.length > 1 ? "start" : i === pts.length - 1 && dates.length > 1 ? "end" : "middle"}
                        className="tabular-nums"
                        paintOrder="stroke"
                        stroke="#ffffff"
                        strokeWidth={3}
                      >
                        {isGrade || q.p.hasScore ? q.p.value : `${q.p.value}%`}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* 날짜 */}
        {dates.map((d, i) => {
          const show = i === 0 || i === dates.length - 1 || i % every === 0;
          if (!show) return null;
          // 끝 날짜와 너무 붙은 중간 날짜는 뺀다.
          if (i !== dates.length - 1 && i !== 0 && dates.length - 1 - i < every / 2) return null;
          return (
            <text
              key={d}
              x={xOf(i)}
              y={height - 9}
              fontSize={11}
              fill={hover === i ? "#191c21" : "#94a3b8"}
              fontWeight={hover === i ? 700 : 400}
              textAnchor={dates.length === 1 ? "middle" : i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}
              className="tabular-nums"
            >
              {fmtDate(d)}
            </text>
          );
        })}
      </svg>

      {/* 누른(가리킨) 날짜의 기록 — 그래프 **아래**에 편다. 그래프 위에 띄우면
          정식 시험 이름과 점을 가려 정작 보려던 것이 안 보인다. */}
      {hoverDate && hoverRows.length > 0 && (
        <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 text-xs">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-semibold text-ink">
              {hoverDate.replace(/-/g, ".")}
              {officialExamOn(hoverDate) && (
                <span className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">
                  {officialExamOn(hoverDate)}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setHover(null)}
              className="-m-1 rounded p-1 text-slate-400 hover:text-slate-600"
              aria-label="닫기"
            >
              ✕
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {hoverRows.map(({ s, p }) => (
              <li key={p.id}>
                <Link href={`/grades/${p.id}`} className="-mx-1 flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-slate-50">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-600">
                      {mode === "all" ? s.label : p.examName ?? s.label}
                    </span>
                    {mode === "all" && p.examName && (
                      <span className="block truncate text-[11px] text-slate-400">{p.examName}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-bold tabular-nums text-ink">{valueText(metric, p)}</span>
                    {p.wrongCount >= 0 && (
                      <span className="block text-[10px] text-slate-400">
                        {p.wrongCount > 0 ? `오답 ${p.wrongCount}` : "전부 정답"}
                      </span>
                    )}
                  </span>
                  <span className="text-slate-300">›</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ScoreTrendChart({
  series,
  gradeSeries = [],
}: {
  series: TrendSeries[];
  /** 등급으로 본 추세. 등급을 하나도 안 적었으면 비어 있고, 그때는 토글을 감춘다. */
  gradeSeries?: TrendSeries[];
}) {
  const hasGrade = gradeSeries.length > 0;
  const hasScore = series.length > 0;
  // 등급만 적어 둔 기록뿐이면 처음부터 등급으로 본다(점수 보기는 비어 있다).
  const [metric, setMetric] = useState<TrendMetric>(hasScore ? "score" : "grade");
  const isGrade = (metric === "grade" && hasGrade) || !hasScore;
  const shownMetric: TrendMetric = isGrade ? "grade" : "score";

  // 색은 점수 목록 기준으로 과목마다 정해 두고 등급 보기에서도 같은 색을 쓴다
  // — 보기를 바꿀 때 과목 색이 바뀌면 헷갈린다.
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    [...series, ...gradeSeries].forEach((s) => {
      if (!m.has(s.key)) m.set(s.key, PALETTE[m.size % PALETTE.length]);
    });
    return m;
  }, [series, gradeSeries]);

  const shown: Colored[] = useMemo(
    () => (isGrade ? gradeSeries : series).map((s) => ({ ...s, color: colorOf.get(s.key) ?? PALETTE[0] })),
    [isGrade, gradeSeries, series, colorOf],
  );

  // 처음에는 가장 최근에 본 시험의 과목을 연다.
  const latestKey = useMemo(() => {
    let best: { key: string; at: string } | null = null;
    for (const s of shown) {
      const at = s.points[s.points.length - 1]?.takenAt ?? "";
      if (!best || at > best.at) best = { key: s.key, at };
    }
    return best?.key ?? null;
  }, [shown]);
  const [picked, setPicked] = useState<Selection | null>(null);
  const selection: Selection | null =
    picked === "all" || (picked && shown.some((s) => s.key === picked)) ? picked : latestKey;

  if (shown.length === 0 || !selection) return null;

  const chartSeries = selection === "all" ? shown : shown.filter((s) => s.key === selection);
  const current = selection === "all" ? null : chartSeries[0];

  return (
    <div className="flex flex-col gap-4">
      {/* 과목 요약 — 한눈에 최근 점수·변화를 보고, 눌러서 아래 그래프를 바꾼다. */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((s) => (
          <SummaryCard
            key={s.key}
            s={s}
            metric={shownMetric}
            selected={selection === s.key}
            onSelect={() => setPicked(s.key)}
          />
        ))}
      </div>

      <div className="g-panel flex flex-col gap-3 p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              {current && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: current.color }} />}
              {current ? current.label : "전체 과목 비교"}
            </p>
            <p className="text-xs text-slate-400">
              {current
                ? `${current.points.length}회 응시${isGrade ? " · 위가 1등급" : ""} · 점을 누르면 그날 기록이 아래에 떠요`
                : isGrade
                  ? "같은 1~9등급 척도로 겹쳐 봅니다 · 위가 1등급"
                  : "만점이 달라 만점 대비 %로 맞춰 겹쳐 봅니다"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {shown.length > 1 && (
              <button
                type="button"
                onClick={() => setPicked(selection === "all" ? latestKey : "all")}
                className={`g-btn g-btn-xs ${selection === "all" ? "g-btn-dark" : "g-btn-outline"}`}
              >
                전체 비교
              </button>
            )}
            {hasGrade && hasScore && (
              <div className="g-seg">
                {(
                  [
                    { v: "score", label: "점수" },
                    { v: "grade", label: "등급" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    data-active={metric === opt.v || undefined}
                    aria-pressed={metric === opt.v}
                    onClick={() => setMetric(opt.v)}
                    className="g-seg-item px-3 py-1 text-xs"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <TrendChart series={chartSeries} metric={shownMetric} mode={selection === "all" ? "all" : "single"} />

        {selection === "all" && (
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-slate-500">
            {shown.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}

        {!isGrade && chartSeries.some((s) => s.points.some((p) => !p.hasScore)) && (
          <p className="text-[11px] text-slate-400">속이 빈 점은 배점이 없어 정답률(%)로 대신한 시험이에요.</p>
        )}
      </div>
    </div>
  );
}
