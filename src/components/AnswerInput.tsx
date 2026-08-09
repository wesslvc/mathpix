"use client";

import { toCircledNumber, type AnswerType } from "@/lib/answer";

/** 보여줄 객관식 번호. 대부분 5지선다지만 넉넉히 5개면 충분하다. */
const CHOICES = [1, 2, 3, 4, 5];

type Props = {
  answer: string;
  answerType: AnswerType;
  onChange: (answer: string, type: AnswerType) => void;
  /** 주관식 칸에서 Enter를 눌렀을 때(바로 저장). */
  onSubmit?: () => void;
};

/**
 * 정답 입력.
 *
 * 예전에는 "객관식/주관식"을 먼저 고르고 그 다음 값을 적게 했는데, 고르는
 * 단계가 군더더기였다. 지금은 **어디에 입력하느냐가 곧 유형이다** —
 * 위의 ①②③④⑤ 중 하나를 누르면 객관식, 아래 칸에 글자를 쓰면 주관식.
 * 둘은 서로 배타적이라 한쪽을 쓰면 다른 쪽은 비워진다.
 */
export default function AnswerInput({
  answer,
  answerType,
  onChange,
  onSubmit,
}: Props) {
  const trimmed = answer.trim();
  const selected =
    answerType === "choice" && /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  const shortValue = answerType === "short" ? answer : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-sm font-medium text-slate-700">정답</span>
        <div className="flex gap-1.5">
          {CHOICES.map((n) => {
            const active = selected === n;
            return (
              <button
                key={n}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  // 누른 번호를 다시 누르면 선택 해제.
                  onChange(active ? "" : String(n), "choice")
                }
                className={`h-9 w-9 rounded-full border text-base leading-none transition-colors ${
                  active
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                }`}
              >
                {toCircledNumber(n)}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <span className="shrink-0 text-xs text-slate-500">주관식</span>
        <input
          value={shortValue}
          onChange={(e) => onChange(e.target.value, "short")}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (e.currentTarget.value.trim() === "") return;
            onSubmit?.();
          }}
          placeholder="예: 12 — 여기에 쓰면 주관식으로 표기됩니다"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </label>

      {trimmed !== "" && (
        <p className="text-[11px] text-slate-500">
          정답표 표기:{" "}
          <span className="text-sm font-medium text-ink">
            {answerType === "choice"
              ? (toCircledNumber(Number(trimmed)) ?? trimmed)
              : trimmed}
          </span>
          <span className="ml-1 text-slate-400">
            ({answerType === "choice" ? "객관식" : "주관식"})
          </span>
        </p>
      )}
    </div>
  );
}
