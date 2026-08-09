"use client";

import { useState } from "react";
import VisualTextEditor from "./VisualTextEditor";
import LatexEditor from "./LatexEditor";

type Props = {
  value: string;
  onChange: (next: string) => void;
};

/**
 * 본문 편집 방식 두 가지.
 *
 * 기본은 "보이는 대로" — 사람들이 LaTeX 원문을 직접 고치는 걸 어색해했다.
 * 다만 원문을 통째로 갈아끼우거나 붙여넣는 게 편할 때도 있어서 LaTeX 편집기도
 * 남겨뒀다. 둘은 같은 값을 다루므로 언제든 오가도 내용이 유지된다.
 */
export default function TextEditTabs({ value, onChange }: Props) {
  const [mode, setMode] = useState<"visual" | "latex">("visual");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {(
          [
            ["visual", "보이는 대로"],
            ["latex", "LaTeX 원문"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
              mode === m
                ? "border-blue-600 bg-blue-50 text-blue-700"
                : "border-slate-300 text-slate-600 hover:bg-slate-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "visual" ? (
        <VisualTextEditor value={value} onChange={onChange} />
      ) : (
        <LatexEditor value={value} onChange={onChange} rows={10} />
      )}
    </div>
  );
}
