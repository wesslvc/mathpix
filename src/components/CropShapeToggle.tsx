"use client";

import type { CropShape } from "@/lib/cropShape";

/**
 * 자르기 모양 고르기(사각형 / 다각형). 자르는 화면마다 같은 모양으로 둔다 —
 * 화면마다 다르게 생기면 같은 설정인 줄 모른다. 여기서 바꾸면 그게 곧 기본값이
 * 된다(`useCropShape`).
 */
export default function CropShapeToggle({
  value,
  onChange,
  size = "sm",
}: {
  value: CropShape;
  onChange: (s: CropShape) => void;
  size?: "sm" | "md";
}) {
  const opts: { v: CropShape; label: string; icon: React.ReactNode }[] = [
    {
      v: "rect",
      label: "사각형",
      icon: (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      ),
    },
    {
      v: "poly",
      label: "다각형",
      icon: (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
          <path d="M3 4 L10 2.5 L13.5 8 L9 13.5 L2.5 11 Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      ),
    },
  ];
  return (
    <div className="g-seg" role="radiogroup" aria-label="자르기 모양">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={`g-seg-item ${size === "md" ? "px-3.5 py-2" : ""}`}
          data-active={value === o.v || undefined}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
