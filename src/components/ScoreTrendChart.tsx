import type { TrendSeries } from "@/lib/scoreTrend";

const WIDTH = 560;
const HEIGHT = 160;
const PAD_LEFT = 28;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

/**
 * 과목 하나의 성적 추세를 그린다. **새 차트 라이브러리를 넣지 않는다** —
 * 점 몇 개를 잇는 꺾은선 하나에 npm 의존성을 하나 더 들일 이유가 없다(이
 * 저장소는 hwpx PDF 조립처럼 더 복잡한 것도 라이브러리 없이 손으로 그려 왔다).
 *
 * 배점이 없어 정답률로 대신한 점은 속을 비운 동그라미로 그려 **점수가 아니라
 * 정답률이라는 것**을 표시한다. 안 그러면 배점이 있는 시험과 없는 시험이
 * 같은 값처럼 보여 오해를 산다.
 */
export default function ScoreTrendChart({ series }: { series: TrendSeries }) {
  const { points } = series;
  if (points.length === 0) return null;

  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const x = (i: number) =>
    points.length === 1
      ? PAD_LEFT + innerW / 2
      : PAD_LEFT + (innerW * i) / (points.length - 1);
  const y = (value: number) => PAD_TOP + innerH * (1 - Math.max(0, Math.min(100, value)) / 100);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const latest = points[points.length - 1];

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-sm font-semibold text-ink">{series.label}</p>
        <p className="text-xs text-slate-400">
          최근 {latest.hasScore ? `${latest.value}점` : `정답률 ${latest.value}%`}
          {latest.wrongCount > 0 && ` · 오답 ${latest.wrongCount}개`}
        </p>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`${series.label} 성적 추세`}>
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={y(g)}
              y2={y(g)}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <text x={2} y={y(g) + 3} fontSize={9} fill="#94a3b8">
              {g}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#2563eb" strokeWidth={2} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={3.5}
            fill={p.hasScore ? "#2563eb" : "#ffffff"}
            stroke="#2563eb"
            strokeWidth={1.5}
          />
        ))}
        {points.map((p, i) => {
          // 점이 많으면 전부 못 넣으니 처음·끝·중간만 날짜를 적는다.
          const show = points.length <= 6 || i === 0 || i === points.length - 1;
          if (!show) return null;
          return (
            <text
              key={i}
              x={x(i)}
              y={HEIGHT - 6}
              fontSize={9}
              fill="#94a3b8"
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            >
              {p.takenAt.slice(5)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
