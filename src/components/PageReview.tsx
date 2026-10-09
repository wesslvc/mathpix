"use client";

import { Button } from "@/components/ui/button";

export type ReviewPiece = { id: string; crop: string; parts: number; no?: number };
export type ReviewPage = {
  key: string;
  name: string;
  status: "finding" | "done" | "error";
  pieces: ReviewPiece[];
  note?: string;
};

/**
 * **지면 여러 장을 사진 넣기처럼 한눈에**(2026-10-09, 사용자 — "이어서 지면 넣기 말고 우리 일반 문제 넣듯이"). 지면을 여러 장
 * 고르면 luna 가 장마다 문제를 찾아 자른 조각이 전부 좌우로 늘어서고(지면 차례대로), 잘못 잘린 것만 "다시 자르기"에 체크한다.
 * 체크 안 한 것은 버튼 하나로 한꺼번에 넣고, 체크한 조각이 든 지면만 손으로 고치는 화면으로 연다(그 조각들의 네모가 미리 놓여
 * 있어 끌어 고치기만 하면 된다). 사진 넣기의 `CropReview` 와 같은 모양이다.
 */
export default function PageReview({
  pages,
  checked,
  onToggle,
  onRemove,
  onAddMore,
  onSubmit,
  onClose,
  cost,
  showCost,
}: {
  pages: ReviewPage[];
  checked: Set<string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAddMore: () => void;
  onSubmit: (kind: "asis" | "ai") => void;
  onClose: () => void;
  /** AI 다시 그리기 한 문제 토큰(표시용). */
  cost: number | null;
  showCost: boolean;
}) {
  const all = pages.flatMap((p) => p.pieces);
  const finding = pages.filter((p) => p.status === "finding").length;
  const failed = pages.filter((p) => p.status === "error");
  const rest = all.filter((p) => !checked.has(p.id)).length;
  const fixPages = pages.filter((p) => p.status === "error" || p.pieces.some((x) => checked.has(x.id))).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">
            지면 {pages.length}장 · 문제 {all.length}개
          </h2>
          <p className="text-xs text-slate-500">
            좌우로 넘겨 보고, 잘못 잘린 것만 <b>다시 자르기</b>에 체크하세요(조각을 눌러도 체크돼요).
            {finding > 0 && ` · luna 가 지면 ${finding}장에서 문제를 찾는 중…`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          닫기
        </Button>
      </div>

      <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:mx-0 sm:px-0">
        {pages.map((pg, pi) => (
          <div key={pg.key} className={`flex shrink-0 gap-2 ${pi > 0 ? "border-l border-slate-200 pl-3" : ""}`}>
            {pg.status === "finding" && (
              <div className="flex h-64 w-40 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-2 text-center text-[11px] text-slate-500">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
                <span className="w-full truncate">지면 {pi + 1} · {pg.name}</span>
                luna 가 찾는 중
              </div>
            )}
            {pg.status === "error" && (
              <div className="flex h-64 w-40 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-red-200 bg-red-50 px-2 text-center text-[11px] text-red-700">
                <span className="w-full truncate font-medium">지면 {pi + 1} · {pg.name}</span>
                {pg.note ?? "문제를 못 찾았어요"}
                <span className="text-red-500">— 넣을 때 손으로 자르는 화면으로 열어요</span>
              </div>
            )}
            {pg.pieces.map((p) => {
              const isChecked = checked.has(p.id);
              return (
                <div
                  key={p.id}
                  className={`relative flex w-[44vw] shrink-0 snap-start flex-col overflow-hidden rounded-xl border bg-white transition sm:w-56 ${
                    isChecked ? "border-amber-400 ring-2 ring-amber-200" : "border-slate-200"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onToggle(p.id)}
                    className="flex h-64 items-center justify-center bg-slate-50 p-1"
                    title="다시 자르기 체크"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.crop} alt="" className="max-h-full max-w-full object-contain" />
                  </button>
                  <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[11px] font-medium text-white">
                    지면 {pi + 1} · {p.no != null ? `${p.no}번` : "번호 ?"}
                    {p.parts > 1 && ` · ${p.parts}조각`}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(p.id)}
                    aria-label="이 조각 빼기"
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-xs text-white hover:bg-red-600"
                  >
                    ×
                  </button>
                  <div className="border-t border-slate-100 px-2.5 py-2">
                    <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggle(p.id)}
                        className="h-4 w-4 accent-amber-500"
                      />
                      다시 자르기
                    </label>
                  </div>
                </div>
              );
            })}
            {pg.status === "done" && pg.note && (
              <div className="flex w-20 shrink-0 items-center text-[10px] leading-tight text-slate-400">{pg.note}</div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={onAddMore}
          className="flex h-64 w-24 shrink-0 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 text-2xl text-slate-400 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
          aria-label="지면 더 넣기"
        >
          +
        </button>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <p className="text-xs text-slate-600">
          {finding > 0 ? (
            <>luna 가 아직 찾는 지면이 있어요 — 다 찾으면 넣을 수 있어요.</>
          ) : (
            <>
              체크 안 한 <b>{rest}개</b>를 아래 방식으로 넣어요
              {fixPages > 0 && ` · 다시 자를 것이 든 지면 ${fixPages}장은 그다음 손으로 고치는 화면으로 열어요`}
              {failed.length > 0 && ` (못 찾은 지면 ${failed.length}장 포함)`}.
            </>
          )}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button type="button" variant="outline" className="whitespace-normal px-2 text-[13px] leading-tight sm:px-4 sm:text-sm" disabled={finding > 0 || (rest === 0 && fixPages === 0)} onClick={() => onSubmit("asis")}>
            {rest > 0 ? `원본 그대로 (${rest}개)` : "다시 자르러 가기"}
          </Button>
          {rest > 0 && (
            <Button type="button" variant="soft" className="whitespace-normal px-2 text-[13px] leading-tight sm:px-4 sm:text-sm" disabled={finding > 0} onClick={() => onSubmit("ai")}>
              AI로 다시 그리기 ({rest}개{showCost && cost != null && ` · ${cost * rest}토큰`})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
