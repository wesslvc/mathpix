"use client";

import { TOKEN_GAUGE_FULL } from "@/lib/tokens";

type Props = {
  tokens: number | null;
  unlimited?: boolean;
  /** 이번에 쓰려는 양. 주면 게이지에 "여기까지 줄어듭니다"를 같이 보여준다. */
  pending?: number;
  className?: string;
};

/**
 * 남은 토큰을 막대로 보여준다.
 *
 * 숫자만 적어두면 "많이 남았는지" 감이 안 온다. 가득 찬 기준은 이용권 1회
 * 구매분(TOKEN_GAUGE_FULL)이고, 그보다 많으면 꽉 찬 것으로 그린다.
 */
export default function TokenGauge({
  tokens,
  unlimited = false,
  pending = 0,
  className,
}: Props) {
  if (unlimited) {
    return (
      <div className={`flex items-center gap-2 ${className ?? ""}`}>
        <span className="text-[11px] font-medium text-emerald-700">토큰 무제한</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-emerald-100">
          <div className="h-full w-full rounded-full bg-emerald-500" />
        </div>
      </div>
    );
  }

  if (tokens === null) return null;

  const ratio = Math.max(0, Math.min(1, tokens / TOKEN_GAUGE_FULL));
  // 이번 사용분을 뺀 뒤의 잔량. 막대에서 이만큼이 곧 사라진다는 표시로 쓴다.
  const afterRatio = Math.max(
    0,
    Math.min(1, (tokens - pending) / TOKEN_GAUGE_FULL),
  );
  const empty = tokens <= 0;
  const low = !empty && tokens < TOKEN_GAUGE_FULL * 0.1;

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <span
        className={`shrink-0 text-[11px] font-medium tabular-nums ${
          empty ? "text-red-600" : low ? "text-amber-700" : "text-slate-600"
        }`}
      >
        {tokens.toLocaleString()} 토큰
      </span>
      <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200">
        {/* 현재 잔량 */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out ${
            empty ? "bg-red-400" : low ? "bg-amber-500" : "bg-blue-600"
          }`}
          style={{ width: `${ratio * 100}%` }}
        />
        {/* 이번에 쓰고 나면 남을 만큼(옅게 겹쳐 그려 줄어들 폭을 보여준다) */}
        {pending > 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-blue-600/40"
            style={{ width: `${afterRatio * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}
