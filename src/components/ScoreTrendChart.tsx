"use client";

import { useMemo, useState } from "react";
import type { TrendSeries } from "@/lib/scoreTrend";

const WIDTH = 720;
const HEIGHT = 260;
const PAD_LEFT = 30;
const PAD_RIGHT = 40;
const PAD_TOP = 16;
const PAD_BOTTOM = 26;

/** 과목마다 다른 색. 탐구가 여러 과목으로 갈리면 순서대로 돌려 쓴다. */
const PALETTE = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#65a30d", "#db2777"];

function pointLabel(hasScore: boolean, value: number): string {
  return hasScore ? `${value}점` : `${value}%`;
}

/**
 * 모든 과목의 성적 추세를 **하나의 그래프**에 겹쳐 그리고, 아래 범례를
 * 눌러 과목 하나만 도드라지게 볼 수 있다("액티브 범례").
 *
 * 예전에는 과목마다 따로 작은 그래프를 그렸다 — 한 화면에서 비교가 안
 * 되고, 탐구 과목이 늘어날수록 타일만 늘어나 시각적으로 산만했다. 지금은
 * 시간축(가로)을 모든 과목이 공유하고, 범례를 누르면 그 과목만 굵게·
 * 나머지는 옅게 표시한다(다시 누르면 전부 원래대로).
 *
 * **점수를 눈에 잘 띄게** 마지막 점 옆에 값을 직접 적는다 — 예전엔
 * 그래프 위에 숫자가 하나도 없어서 헤더의 작은 글자("최근 N점")로만
 * 알 수 있었다. 배점이 없어 정답률로 대신한 점은 속을 비운 동그라미로
 * 그려 점수와 구분한다.
 *
 * **새 차트 라이브러리를 넣지 않는다** — 선 몇 개 겹쳐 그리는 정도에
 * npm 의존성을 하나 더 들일 이유가 없다.
 */
export default function ScoreTrendChart({ series }: { series: TrendSeries[] }) {
  const [active, setActive] = useState<string | null>(null);

  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const p of s.points) set.add(p.takenAt);
    return [...set].sort();
  }, [series]);

  if (series.length === 0 || dates.length === 0) return null;

  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const xOf = (date: string) => {
    const i = dates.indexOf(date);
    return dates.length === 1 ? PAD_LEFT + innerW / 2 : PAD_LEFT + (innerW * i) / (dates.length - 1);
  };
  const yOf = (value: number) => PAD_TOP + innerH * (1 - Math.max(0, Math.min(100, value)) / 100);

  const colored = series.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="성적 추세"
      >
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yOf(g)}
              y2={yOf(g)}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <text x={2} y={yOf(g) + 3} fontSize={9} fill="#94a3b8">
              {g}
            </text>
          </g>
        ))}

        {colored.map((s) => {
          const isActive = active === s.key;
          const isDimmed = active !== null && !isActive;
          const path = s.points
            .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.takenAt)},${yOf(p.value)}`)
            .join(" ");
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.key} opacity={isDimmed ? 0.18 : 1} style={{ transition: "opacity 150ms" }}>
              <path d={path} fill="none" stroke={s.color} strokeWidth={isActive ? 3 : 2} />
              {s.points.map((p, i) => (
                <circle
                  key={i}
                  cx={xOf(p.takenAt)}
                  cy={yOf(p.value)}
                  r={isActive ? 4.5 : 3.5}
                  fill={p.hasScore ? s.color : "#ffffff"}
                  stroke={s.color}
                  strokeWidth={1.5}
                >
                  <title>{`${s.label} · ${p.takenAt} · ${pointLabel(p.hasScore, p.value)}`}</title>
                </circle>
              ))}
              {/* 마지막 점 값 — 점수가 그래프 안에서 바로 눈에 들어오게. */}
              <text
                x={xOf(last.takenAt) + 7}
                y={yOf(last.value) + 3.5}
                fontSize={11}
                fontWeight={700}
                fill={s.color}
                opacity={isDimmed ? 0.5 : 1}
              >
                {pointLabel(last.hasScore, last.value)}
              </text>
            </g>
          );
        })}

        {dates.map((d, i) => {
          // 날짜가 많으면 전부 못 넣으니 처음·끝·중간만 적는다.
          const show = dates.length <= 6 || i === 0 || i === dates.length - 1;
          if (!show) return null;
          return (
            <text
              key={d}
              x={xOf(d)}
              y={HEIGHT - 8}
              fontSize={9}
              fill="#94a3b8"
              textAnchor={i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}
            >
              {d.slice(5)}
            </text>
          );
        })}
      </svg>

      {/* 액티브 범례 — 누르면 그 과목만 굵게 보이고 나머지는 옅어진다.
          다시 누르면 전부 원래대로. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {colored.map((s) => {
          const isActive = active === s.key;
          const isDimmed = active !== null && !isActive;
          const last = s.points[s.points.length - 1];
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActive(isActive ? null : s.key)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all ${
                isActive
                  ? "border-slate-300 bg-slate-100"
                  : isDimmed
                    ? "border-slate-100 bg-white opacity-50"
                    : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="font-medium text-ink">{s.label}</span>
              <span className="text-slate-400">{pointLabel(last.hasScore, last.value)}</span>
              {last.wrongCount > 0 && (
                <span className="text-slate-400">· 오답 {last.wrongCount}개</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
