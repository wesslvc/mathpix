"use client";

import { useMemo, useRef } from "react";
import type { QueuedPhoto } from "@/lib/photoQueue";

/**
 * 여러 장 넣을 때의 사진 줄. 지금 자르는 사진 · 남은 사진을 작은 그림으로 늘어놓고,
 * 눌러서 그 사진으로 건너뛰거나 × 로 빼고, 끝에서 사진을 더 넣는다.
 *
 * 예전에는 "N장 남음" 한 줄뿐이라 무엇이 남았는지 안 보였고, 잘못 고른 사진을
 * 빼려면 그 차례까지 가서 "다른 이미지 선택"을 눌러야 했다(그러면 대기열이 통째로
 * 날아갔다).
 *
 * 작은 그림은 **미리 줄여 둔 것**(`thumb`, 긴 변 240px)만 그린다 — 3000px 짜리를
 * 40px 칸에 그려도 브라우저는 원본 크기로 디코딩해 메모리를 먹는다.
 */
export default function PhotoQueueStrip({
  active,
  pending,
  preparing,
  onJump,
  onRemove,
  onAdd,
}: {
  active: QueuedPhoto | null;
  pending: QueuedPhoto[];
  /** 사진을 줄이는 중이면 진행 상황. */
  preparing: { done: number; total: number } | null;
  onJump: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const all = useMemo(() => (active ? [active, ...pending] : pending), [active, pending]);
  const urls = useThumbUrls(all);
  const total = all.length;

  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {all.map((p, i) => {
          const isActive = active?.id === p.id;
          return (
            <div
              key={p.id}
              className={`group relative h-16 w-12 shrink-0 overflow-hidden rounded-lg border bg-white transition ${
                isActive ? "border-blue-600 ring-2 ring-blue-200" : "border-slate-200 hover:border-slate-400"
              }`}
            >
              <button
                type="button"
                onClick={() => !isActive && onJump(p.id)}
                className="block h-full w-full"
                title={isActive ? "지금 자르는 사진" : `${i + 1}번째 사진으로 건너뛰기`}
                aria-current={isActive || undefined}
              >
                {urls.get(p.id) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={urls.get(p.id)} alt="" className="h-full w-full object-cover" />
                )}
              </button>
              <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-black/55 px-1 text-[10px] font-medium leading-tight text-white">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => onRemove(p.id)}
                aria-label={`${i + 1}번째 사진 빼기`}
                className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-[11px] leading-none text-white opacity-90 hover:bg-red-600 sm:opacity-0 sm:group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          );
        })}
        {preparing && (
          <div className="flex h-16 w-12 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 bg-slate-50 text-[10px] text-slate-500">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
            {preparing.done}/{preparing.total}
          </div>
        )}
        <button
          type="button"
          onClick={onAdd}
          className="flex h-16 w-12 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 text-lg text-slate-400 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
          aria-label="사진 더 넣기"
          title="사진 더 넣기"
        >
          +
        </button>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-slate-500">
        {total > 0 ? `${total}장 남음` : ""}
      </span>
    </div>
  );
}

/**
 * 사진마다 작은 그림 주소를 만들어 두고, 줄에서 빠진 것은 풀어 준다.
 *
 * 화면이 사라질 때 한꺼번에 풀지는 않는다 — 개발 모드(StrictMode)가 이펙트를
 * 붙였다 뗐다 하면 멀쩡한 그림이 깨진다. 작은 그림 몇 장(장당 20kB 안팎)이라
 * 탭을 닫을 때까지 남아 있어도 문제없다.
 */
function useThumbUrls(photos: QueuedPhoto[]): Map<string, string> {
  const cache = useRef(new Map<string, string>());
  const ids = photos.map((p) => p.id).join(",");
  return useMemo(() => {
    const next = new Map<string, string>();
    for (const p of photos) {
      next.set(p.id, cache.current.get(p.id) ?? URL.createObjectURL(p.thumb));
    }
    for (const [id, url] of cache.current) if (!next.has(id)) URL.revokeObjectURL(url);
    cache.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
}
