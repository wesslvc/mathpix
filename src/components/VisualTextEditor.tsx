"use client";

import { useEffect, useRef, useState } from "react";
import katex from "katex";
import {
  joinMathTokens,
  tokenizeMath,
  type MathToken,
} from "@/lib/mathTokens";

type Props = {
  value: string;
  onChange: (next: string) => void;
};

/**
 * 보이는 글씨를 그대로 고치는 편집기.
 *
 * LaTeX 원문을 직접 고치는 건 대부분의 사람에게 어색하다("$\\frac{1}{2}$"를
 * 보고 고치라고 하면 손이 안 나간다). 여기서는 **화면에 보이는 대로** 고친다 —
 * 글자는 그냥 타이핑하고, 수식은 하나의 덩어리(칩)로 다룬다. 다 고치면 원문이
 * 알아서 다시 만들어진다.
 *
 * AI는 전혀 쓰지 않는다. 원문을 "글자 / 수식" 조각으로 쪼개 두고, 편집이 끝나면
 * 그 조각을 다시 이어 붙일 뿐이라 손대지 않은 부분은 글자 하나 안 바뀐다.
 *
 * 왜 contentEditable 한 덩어리가 아니라 조각별 입력인가: 브라우저마다
 * contentEditable이 만들어내는 마크업이 제각각이라(줄바꿈을 <br>로 넣는 곳,
 * <div>로 감싸는 곳) 거기서 원문을 복원하면 반드시 어긋난다. 조각을 따로
 * 두면 무엇이 글자이고 무엇이 수식인지 항상 확실하다.
 */
export default function VisualTextEditor({ value, onChange }: Props) {
  // 편집 중에는 이쪽 상태를 쓴다. 밖에서 값이 바뀌면(인식 결과 교체 등)
  // 다시 쪼갠다.
  const [tokens, setTokens] = useState<MathToken[]>(() => tokenizeMath(value));
  const lastEmitted = useRef(value);

  useEffect(() => {
    // 우리가 방금 올려보낸 값이 되돌아온 것이면 다시 쪼개지 않는다
    // (커서가 튀고 입력이 끊긴다).
    if (value === lastEmitted.current) return;
    setTokens(tokenizeMath(value));
    lastEmitted.current = value;
  }, [value]);

  function commit(next: MathToken[]) {
    setTokens(next);
    const joined = joinMathTokens(next);
    lastEmitted.current = joined;
    onChange(joined);
  }

  function updateAt(i: number, token: MathToken) {
    commit(tokens.map((t, idx) => (idx === i ? token : t)));
  }

  function removeAt(i: number) {
    // 수식을 지우면 앞뒤 글자 조각이 서로 붙어야 다음 편집이 자연스럽다.
    const next = tokens.filter((_, idx) => idx !== i);
    const merged: MathToken[] = [];
    for (const t of next) {
      const prev = merged[merged.length - 1];
      if (t.kind === "text" && prev?.kind === "text") {
        merged[merged.length - 1] = { kind: "text", value: prev.value + t.value };
        continue;
      }
      merged.push(t);
    }
    commit(merged.length > 0 ? merged : [{ kind: "text", value: "" }]);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-slate-400">
        보이는 글씨를 그대로 고치면 됩니다. 수식은 하나의 덩어리라 눌러서 따로
        고치거나 지울 수 있어요.
      </p>

      <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-white p-2">
        {tokens.map((t, i) =>
          t.kind === "text" ? (
            <TextChunk
              key={i}
              value={t.value}
              onChange={(v) => updateAt(i, { kind: "text", value: v })}
            />
          ) : (
            <MathChip
              key={i}
              token={t}
              onChange={(latex) => updateAt(i, { ...t, latex })}
              onRemove={() => removeAt(i)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** 글자 조각. 여러 줄이 들어가므로 높이가 내용에 맞춰 늘어난다. */
function TextChunk({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 스크롤바 없이 내용만큼만 차지하게 한다.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      spellCheck={false}
      className="w-full resize-none rounded border border-transparent bg-transparent px-1.5 py-1 font-serif text-[15px] leading-7 text-ink outline-none hover:border-slate-200 focus:border-blue-400 focus:bg-blue-50/30"
    />
  );
}

/** 수식 조각. 평소엔 렌더링된 모습이고, 누르면 그 수식만 고칠 수 있다. */
function MathChip({
  token,
  onChange,
  onRemove,
}: {
  token: Extract<MathToken, { kind: "math" }>;
  onChange: (latex: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(token.latex);

  useEffect(() => setDraft(token.latex), [token.latex]);

  const html = (() => {
    try {
      return katex.renderToString(`\\displaystyle ${token.latex}`, {
        throwOnError: false,
        displayMode: token.display,
        strict: "ignore",
      });
    } catch {
      return "";
    }
  })();

  return (
    <div className="rounded border border-slate-200 bg-slate-50/60">
      <div className="flex items-center gap-2 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="눌러서 이 수식만 고치기"
          className="min-w-0 flex-1 overflow-x-auto text-left"
        >
          {html ? (
            <span dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <span className="text-xs text-red-600">{token.latex}</span>
          )}
        </button>
        <span className="shrink-0 text-[10px] text-slate-400">
          {token.display ? "수식(줄)" : "수식"}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="이 수식 지우기"
          className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
        >
          삭제
        </button>
      </div>

      {open && (
        <div className="flex items-center gap-1.5 border-t border-slate-200 px-1.5 py-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onChange(draft)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              onChange(draft);
              setOpen(false);
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 font-mono text-xs outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
            className="shrink-0 rounded bg-blue-600 px-2 py-1 text-[10px] text-white hover:bg-blue-700"
          >
            적용
          </button>
        </div>
      )}
    </div>
  );
}
