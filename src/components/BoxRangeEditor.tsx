"use client";

import { useMemo, useState } from "react";
import {
  fromBoxRanges,
  getTextLines,
  renderPreviewLine,
  renderMathTextWithInfo,
  toBoxRanges,
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

/** 이 줄이 몇 번째 박스에 들어가는지. 어디에도 없으면 -1. */
function boxIndexOf(ranges: BoxRange[], line: number): number {
  return ranges.findIndex((r) => line >= r.start && line <= r.end);
}

/**
 * 조건 박스(문제집의 테두리 박스)를 어디부터 어디까지 칠지 사용자가 직접
 * 고르는 UI. 박스는 여러 개 만들 수 있다 — 조건 박스와 <보기> 박스가 한
 * 문제에 같이 나오는 경우가 흔하기 때문이다.
 *
 * 자동 감지 규칙(마지막 조건 문장의 마침표까지, 질문/선택지 줄을 만나면 중단)이
 * 대부분 맞으므로 자동 결과를 먼저 그대로 보여주고, 사용자가 박스를 추가하거나
 * 시작/끝 줄을 눌러 고칠 수 있게 한다. 고치지 않으면 undefined인 채로 두어
 * 계속 자동 감지에 맡긴다(원문을 수정하면 자동 결과도 따라 바뀌는 게
 * 자연스럽기 때문).
 */
export default function BoxRangeEditor({ text, value, onChange }: Props) {
  const lines = useMemo(() => getTextLines(text), [text]);
  const autoRanges = useMemo(() => renderMathTextWithInfo(text).boxes, [text]);

  // 지금 시작/끝 버튼이 영향을 주는 박스. 박스가 지워지면 범위를 벗어날 수
  // 있어서 쓰는 쪽에서 항상 clamp한다(state로 붙잡아두면 어긋난다).
  const [activeRaw, setActiveRaw] = useState(0);

  // 실제로 화면에 그려질 범위: 사용자가 정했으면 그것, 아니면 자동 감지 결과.
  const isAuto = toBoxRanges(value) === null;
  const ranges = toBoxRanges(value) ?? autoRanges;
  const active = Math.min(Math.max(activeRaw, 0), Math.max(ranges.length - 1, 0));

  function commit(next: BoxRange[], focus?: number) {
    onChange(fromBoxRanges(next));
    if (focus !== undefined) setActiveRaw(focus);
  }

  /** 활성 박스의 한쪽 끝을 이 줄로 옮긴다. 박스가 하나도 없으면 새로 만든다. */
  function setEdge(line: number, edge: "start" | "end") {
    if (ranges.length === 0) {
      commit([{ start: line, end: line }], 0);
      return;
    }
    const next = ranges.map((r, i) => {
      if (i !== active) return r;
      return edge === "start"
        ? { start: line, end: Math.max(r.end, line) }
        : { start: Math.min(r.start, line), end: line };
    });
    commit(next, active);
  }

  /** 마지막 박스 다음의 빈 줄이 아닌 첫 줄에 새 박스를 만든다. */
  function addBox() {
    const after = ranges.length === 0 ? 0 : ranges[ranges.length - 1].end + 1;
    let at = -1;
    for (let i = after; i < lines.length; i++) {
      if (lines[i].trim() !== "") {
        at = i;
        break;
      }
    }
    if (at === -1) at = Math.max(lines.length - 1, 0);
    commit([...ranges, { start: at, end: at }], ranges.length);
  }

  function removeBox(i: number) {
    commit(
      ranges.filter((_, idx) => idx !== i),
      Math.max(i - 1, 0),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">
          조건 박스 {ranges.length > 0 && `${ranges.length}개`}
          {isAuto && (
            <span className="ml-1 font-normal text-slate-400">(자동 감지됨)</span>
          )}
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onChange(undefined)}
            disabled={isAuto}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            자동으로 되돌리기
          </button>
          <button
            type="button"
            onClick={() => commit([], 0)}
            className={`rounded border px-2 py-1 text-[11px] ${
              ranges.length === 0
                ? "border-blue-600 bg-blue-50 text-blue-700"
                : "border-slate-300 text-slate-600 hover:bg-slate-100"
            }`}
          >
            박스 없음
          </button>
        </div>
      </div>

      {/* 박스 목록. 여기서 고른 박스가 아래 시작/끝 버튼의 대상이 된다. */}
      <div className="flex flex-wrap items-center gap-1">
        {ranges.map((r, i) => (
          <span
            key={i}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
              i === active
                ? "border-blue-600 bg-blue-50 text-blue-700"
                : "border-slate-300 text-slate-600"
            }`}
          >
            <button
              type="button"
              onClick={() => setActiveRaw(i)}
              className="tabular-nums"
            >
              박스 {i + 1} · {r.start + 1}~{r.end + 1}줄
            </button>
            <button
              type="button"
              onClick={() => removeBox(i)}
              aria-label={`박스 ${i + 1} 삭제`}
              className="text-slate-400 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={addBox}
          className="rounded-full border border-dashed border-slate-400 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
        >
          + 박스 추가
        </button>
      </div>

      <p className="text-[11px] text-slate-400">
        {ranges.length === 0 ? (
          <>박스가 없습니다. 줄의 시작/끝을 누르거나 “박스 추가”로 만드세요.</>
        ) : (
          <>
            지금 고치는 박스는{" "}
            <span className="font-medium text-blue-600">박스 {active + 1}</span>
            입니다. 각 줄의 <span className="font-medium">시작</span> /{" "}
            <span className="font-medium">끝</span>을 눌러 범위를 조절하세요.
          </>
        )}
      </p>

      <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
        {lines.map((line, i) => {
          const blank = line.trim() === "";
          const boxIdx = boxIndexOf(ranges, i);
          const isActiveBox = boxIdx === active;
          return (
            <div
              key={i}
              className={`flex items-start gap-2 border-b border-slate-100 px-2 py-1 last:border-b-0 ${
                boxIdx === -1
                  ? "bg-white"
                  : isActiveBox
                    ? "bg-blue-100"
                    : "bg-blue-50"
              }`}
            >
              <span className="w-6 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-slate-400">
                {i + 1}
              </span>
              {/* 박스가 둘 이상일 때만 몇 번 박스인지 표시한다(하나면 군더더기). */}
              {ranges.length > 1 && (
                <span
                  className={`w-3 shrink-0 pt-0.5 text-[10px] tabular-nums ${
                    isActiveBox ? "text-blue-700" : "text-blue-400"
                  }`}
                >
                  {boxIdx === -1 ? "" : boxIdx + 1}
                </span>
              )}
              <div className="min-w-0 flex-1 overflow-x-auto text-[13px] leading-snug text-ink">
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
                  onClick={() => setEdge(i, "start")}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    ranges[active]?.start === i
                      ? "bg-blue-600 text-white"
                      : "border border-slate-200 text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  시작
                </button>
                <button
                  type="button"
                  onClick={() => setEdge(i, "end")}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    ranges[active]?.end === i
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
