"use client";

import {
  FONT_PT_PRESETS,
  MAX_FONT_PT,
  MIN_FONT_PT,
  normalizeFontPt,
} from "@/lib/fontSize";

type Props = {
  value: number;
  onChange: (pt: number) => void;
};

/**
 * 본문 글자 크기. 자주 쓰는 몇 가지를 버튼으로 두고, 그 사이 값이 필요하면
 * pt를 직접 적는다. 인쇄물이라 단위를 px가 아니라 pt로 보여준다.
 */
export default function FontSizeControl({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-300 p-1">
      {FONT_PT_PRESETS.map((f) => (
        <button
          key={f.label}
          type="button"
          onClick={() => onChange(f.pt)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            Math.abs(value - f.pt) < 0.05
              ? "bg-blue-600 text-white"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {f.label}
        </button>
      ))}
      <label className="flex items-center gap-1 pl-1">
        <input
          type="number"
          value={value}
          min={MIN_FONT_PT}
          max={MAX_FONT_PT}
          step={0.5}
          onChange={(e) => onChange(normalizeFontPt(e.target.value))}
          aria-label="글자 크기(pt)"
          className="w-14 rounded border border-slate-300 px-1.5 py-1 text-right text-xs tabular-nums outline-none focus:border-blue-500"
        />
        <span className="text-[11px] text-slate-500">pt</span>
      </label>
    </div>
  );
}
