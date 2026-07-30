"use client";

import { useRef } from "react";

/** 자주 쓰는 LaTeX 조각. `${}`는 커서를 놓을 자리를 뜻한다. */
const SNIPPETS: { label: string; insert: string; title: string }[] = [
  { label: "$x$", insert: "$${}$", title: "인라인 수식" },
  { label: "$$x$$", insert: "\n$$\n${}\n$$\n", title: "블록 수식(가운데 정렬)" },
  { label: "a/b", insert: "\\frac{${}}{}", title: "분수" },
  { label: "x²", insert: "^{${}}", title: "위 첨자" },
  { label: "xₙ", insert: "_{${}}", title: "아래 첨자" },
  { label: "√", insert: "\\sqrt{${}}", title: "루트" },
  { label: "∑", insert: "\\sum_{${}}^{}", title: "시그마" },
  { label: "∫", insert: "\\int_{${}}^{}", title: "적분" },
  { label: "lim", insert: "\\lim_{${} \\to }", title: "극한" },
  { label: "(가)", insert: "(가) ${}", title: "조건 표지" },
];

type Props = {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
};

/**
 * mmd/LaTeX 원문 편집기.
 *
 * 그냥 textarea만 두면 수식을 고치기가 매우 불편하다는 피드백이 있어서
 * (1) 글자를 키우고 줄 간격을 넓혀 기호가 서로 붙어 보이지 않게 하고,
 * (2) 자주 쓰는 LaTeX 조각을 커서 위치에 끼워 넣는 버튼을 붙이고,
 * (3) 선택한 텍스트가 있으면 그걸 감싸도록 했다($ 버튼으로 수식화).
 */
export default function LatexEditor({ value, onChange, rows = 14 }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insert(template: string) {
    const el = ref.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);

    // "${}" 자리에 선택한 텍스트를 넣는다(선택이 없으면 커서만 그 자리에 둔다).
    const holder = template.indexOf("${}");
    const filled = template.replace("${}", selected);

    const next = value.slice(0, start) + filled + value.slice(end);
    onChange(next);

    // 삽입 후 커서 위치: 선택이 있었으면 끼워 넣은 내용 뒤, 없으면 자리 표시 지점.
    const caret =
      holder === -1
        ? start + filled.length
        : start + holder + (selected.length || 0);

    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {SNIPPETS.map((s) => (
          <button
            key={s.label}
            type="button"
            title={s.title}
            onClick={() => insert(s.insert)}
            className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
          >
            {s.label}
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        wrap="off"
        className="w-full resize-y overflow-x-auto rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-[13px] leading-7 tracking-tight text-ink focus:border-blue-500 focus:bg-white focus:outline-none"
      />
      <p className="text-[11px] text-slate-400">
        수식은 <code className="font-mono">$...$</code>(문장 안) 또는{" "}
        <code className="font-mono">$$...$$</code>(가운데 정렬)로 감싸세요. 줄을
        바꾸면 그대로 줄바꿈되고, 빈 줄을 넣으면 문단이 나뉩니다.
      </p>
    </div>
  );
}
