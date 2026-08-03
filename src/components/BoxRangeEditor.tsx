"use client";

import { useMemo } from "react";
import {
  getTextLines,
  renderPreviewLine,
  renderMathTextWithInfo,
  type BoxOverride,
  type BoxRange,
} from "@/lib/renderMathText";

type Props = {
  /** 문제 원문(mmd). 줄 번호는 이 텍스트를 기준으로 매겨진다. */
  text: string;
  /** 현재 지정값. undefined면 자동 감지 결과를 그대로 쓴다. */
  value: BoxOverride | undefined;
  onChange: (next: BoxOverride | undefined) => void;
};

/**
 * 조건 박스(문제집의 테두리 박스)를 어디부터 어디까지 칠지 사용자가 직접
 * 고르는 UI.
 *
 * 자동 감지 규칙(마지막 조건 문장의 마침표까지, 질문/선택지 줄을 만나면 중단)이
 * 대부분 맞지만 원문이 특이하면 어긋난다. 그래서 자동 결과를 먼저 그대로
 * 보여주고, 사용자가 시작/끝 줄을 눌러 고칠 수 있게 한다. 고치지 않으면
 * undefined인 채로 두어 계속 자동 감지에 맡긴다(원문을 수정하면 자동 결과도
 * 따라 바뀌는 게 자연스럽기 때문).
 */
export default function BoxRangeEditor({ text, value, onChange }: Props) {
  const lines = useMemo(() => getTextLines(text), [text]);
  const autoBox = useMemo(() => renderMathTextWithInfo(text).box, [text]);

  // 실제로 화면에 그려질 범위: 사용자가 정했으면 그것, 아니면 자동 감지 결과.
  const effective: BoxRange | null =
    value === undefined
      ? autoBox
      : value === null || "none" in value
        ? null
        : value;

  function setStart(i: number) {
    const end = effective ? Math.max(effective.end, i) : i;
    onChange({ start: i, end });
  }

  function setEnd(i: number) {
    const start = effective ? Math.min(effective.start, i) : i;
    onChange({ start, end: i });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500 dark:text-[#9aa0a6]">
          조건 박스 범위
          {value === undefined && (
            <span className="ml-1 font-normal text-slate-400 dark:text-[#80868b]">(자동 감지됨)</span>
          )}
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onChange(undefined)}
            disabled={value === undefined}
            className="rounded border border-slate-300 dark:border-[#4a4d51] px-2 py-1 text-[11px] text-slate-600 dark:text-[#bdc1c6] hover:bg-slate-100 dark:hover:bg-[#303134] disabled:opacity-40"
          >
            자동으로 되돌리기
          </button>
          <button
            type="button"
            onClick={() => onChange({ none: true })}
            className={`rounded border px-2 py-1 text-[11px] ${
              effective === null
                ? "border-blue-600 bg-blue-50 text-blue-700"
                : "border-slate-300 text-slate-600 hover:bg-slate-100"
            }`}
          >
            박스 없음
          </button>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 dark:text-[#80868b]">
        각 줄의 <span className="font-medium">시작</span> /{" "}
        <span className="font-medium">끝</span>을 눌러 박스 범위를 조절하세요.
        파란 배경이 박스에 들어갈 줄입니다.
      </p>

      <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 dark:border-[#3c4043]">
        {lines.map((line, i) => {
          const blank = line.trim() === "";
          const inBox =
            effective !== null && i >= effective.start && i <= effective.end;
          return (
            <div
              key={i}
              className={`flex items-start gap-2 border-b border-slate-100 px-2 py-1 last:border-b-0 ${
                inBox ? "bg-blue-50" : "bg-white"
              }`}
            >
              <span className="w-6 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-slate-400 dark:text-[#80868b]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 overflow-x-auto text-[13px] leading-snug text-ink dark:text-[#e8eaed]">
                {blank ? (
                  <span className="text-slate-300">(빈 줄)</span>
                ) : (
                  <span
                    dangerouslySetInnerHTML={{
                      __html: renderPreviewLine(line, text),
                    }}
                  />
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => setStart(i)}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    effective?.start === i
                      ? "bg-blue-600 text-white"
                      : "border border-slate-200 text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  시작
                </button>
                <button
                  type="button"
                  onClick={() => setEnd(i)}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    effective?.end === i
                      ? "bg-blue-600 text-white"
                      : "border border-slate-200 text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  끝
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
