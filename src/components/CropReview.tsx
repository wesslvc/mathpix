"use client";

import type { QueuedPhoto } from "@/lib/photoQueue";
import type { Region } from "@/lib/polygon";
import { SOL_TYPESET_TOKENS } from "@/lib/tokens";
import { useThumbUrls } from "./PhotoQueueStrip";
import { Button } from "@/components/ui/button";

export type CropPreview = { region: Region; url: string; ai: boolean };
type AddMode = "asis" | "problem" | "sol";

/**
 * **자동 자르기 결과를 한눈에 본다**(2026-10-04, 사용자 — "자동 자르기 했을 때 한 번에 보여 줘서 다시 자르기 대상자를
 * 체크 가능하게 해, 그리고 좌우 스크롤로 고를 수 있게"). 여러 장을 올리면 luna 가 자른 결과가 좌우로 늘어서고, 잘못
 * 잘린 것만 "다시 자르기"에 체크한다. 체크 안 한 것은 버튼 하나로 한꺼번에 넣고, 체크한 것만 하나씩 자르기 화면으로 연다.
 * 사진을 누르면 그 사진만 곧바로 자르기 화면으로 연다.
 */
export default function CropReview({
  photos,
  previews,
  aiCrops,
  checked,
  preparing,
  onToggle,
  onOpen,
  onRemove,
  onAddMore,
  onSubmit,
  onOneByOne,
  onClose,
  problemTokenCost,
  unlimited,
  byok,
}: {
  photos: QueuedPhoto[];
  previews: Record<string, CropPreview>;
  /** luna 결과(없으면 자르는 중, null 이면 못 찾음). */
  aiCrops: Record<string, Region | null>;
  checked: Set<string>;
  preparing: { done: number; total: number } | null;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onAddMore: () => void;
  onSubmit: (mode: AddMode) => void;
  onOneByOne: () => void;
  onClose: () => void;
  problemTokenCost: number | null;
  unlimited: boolean;
  byok: boolean;
}) {
  const thumbs = useThumbUrls(photos);
  const rest = photos.length - photos.filter((p) => checked.has(p.id)).length;
  const waiting = photos.filter((p) => !previews[p.id]).length;
  const cost = (n: number | null) =>
    byok ? <span className="text-[10px] font-medium opacity-70 sm:text-[11px]">본인 키</span>
      : !unlimited && typeof n === "number" ? <span className="text-[10px] font-medium opacity-70 sm:text-[11px]">{n}토큰씩</span>
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">자동으로 자른 결과 ({photos.length}장)</h2>
          <p className="text-xs text-slate-500">
            좌우로 넘겨 보고, 잘못 잘린 것만 <b>다시 자르기</b>에 체크하세요. 사진을 누르면 그 사진만 바로 자를 수 있어요.
            {waiting > 0 && ` · luna 가 ${waiting}장 자르는 중…`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          닫기
        </Button>
      </div>

      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:mx-0 sm:px-0">
        {photos.map((p, i) => {
          const pv = previews[p.id];
          const isChecked = checked.has(p.id);
          const state = !(p.id in aiCrops) ? "luna 가 자르는 중" : pv ? (pv.ai ? "luna 가 자름" : "자동 계산") : "준비 중";
          return (
            <div
              key={p.id}
              className={`relative flex w-[44%] shrink-0 snap-start flex-col overflow-hidden rounded-xl border bg-white transition sm:w-52 ${
                isChecked ? "border-amber-400 ring-2 ring-amber-200" : "border-slate-200"
              }`}
            >
              <button
                type="button"
                onClick={() => onOpen(p.id)}
                className="relative flex h-56 items-center justify-center bg-slate-100 sm:h-64"
                title="이 사진만 바로 자르기"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pv?.url ?? thumbs.get(p.id)}
                  alt={`${i + 1}번째 사진`}
                  className={`max-h-full max-w-full object-contain ${pv ? "" : "opacity-60"}`}
                />
                {!pv && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
                  </span>
                )}
                <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-white/85 px-1.5 text-[10px] text-slate-600">
                  {state}
                </span>
              </button>
              <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[11px] font-medium text-white">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => onRemove(p.id)}
                aria-label={`${i + 1}번째 사진 빼기`}
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
        {preparing && (
          <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 bg-slate-50 text-[11px] text-slate-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
            {preparing.done}/{preparing.total}
          </div>
        )}
        <button
          type="button"
          onClick={onAddMore}
          className="flex w-24 shrink-0 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 text-2xl text-slate-400 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
          aria-label="사진 더 넣기"
        >
          +
        </button>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <p className="text-xs text-slate-600">
          {rest > 0 ? (
            <>
              체크 안 한 <b>{rest}장</b>을 아래 방식으로 넣어요
              {checked.size > 0 && ` · 다시 자를 ${checked.size}장은 그다음 하나씩 열어요`}.
            </>
          ) : (
            <>모두 다시 자르기로 골랐어요 — 하나씩 열어 자르세요.</>
          )}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {rest > 0 && (
            <>
              <Button type="button" variant="outline" onClick={() => onSubmit("asis")} className="whitespace-normal px-2 text-[13px] leading-tight sm:px-4 sm:text-sm">
                원본 그대로
              </Button>
              <Button type="button" variant="soft" onClick={() => onSubmit("problem")} className="flex-col gap-0 whitespace-normal px-2 text-[13px] leading-tight sm:flex-row sm:gap-1.5 sm:px-4 sm:text-sm">
                AI로 다시 그리기
                {cost(problemTokenCost)}
              </Button>
              <Button type="button" variant="soft" onClick={() => onSubmit("sol")} className="flex-col gap-0 whitespace-normal px-2 text-[13px] leading-tight sm:flex-row sm:gap-1.5 sm:px-4 sm:text-sm">
                sol로 인식
                {cost(SOL_TYPESET_TOKENS)}
              </Button>
            </>
          )}
          <Button type="button" variant={rest > 0 ? "ghost" : "primary"} onClick={onOneByOne} className="whitespace-normal px-2 text-[13px] leading-tight sm:px-4 sm:text-sm">
            {rest > 0 ? "하나씩 자르기" : "하나씩 자르기 시작"}
          </Button>
        </div>
      </div>
    </div>
  );
}
