"use client";

import { useMemo, useState } from "react";
import AddProblemFlow from "./AddProblemFlow";
import type { GradedItemRow } from "@/lib/supabase/types";

type Props = {
  categoryId: string;
  canAdd: boolean;
  /** 이 채점 기록(exam_scores.id) — 새로 올리는 문제에 명시적으로 연결해 둔다. */
  gradeId: string;
  /** 어느 시험의 채점인지(연결된 채점이 여럿일 수 있어 구분이 필요하다). */
  title?: string;
  /** 자동채점이 틀렸다고 한 번호 전부. */
  wrongNumbers: number[];
  /** 이 실모에 이미 저장된 문제들의 번호(box_range.number 또는 본문에서 뽑은 값). */
  existingNumbers: number[];
  /**
   * 채점 때 읽어 둔 문항별 정답. 번호를 고르면 그 문항의 정답을 정답 칸에
   * 미리 채워 준다("정답표 자동 매핑") — 옛 채점 기록에는 없을 수 있다.
   */
  items?: GradedItemRow[] | null;
};

/**
 * 자동채점과 연동된 오답추가. **번호부터 고르고, 그다음에 사진을 올린다** —
 * 사용자가 확정한 순서다. "문제 번호"를 직접 타이핑하는 대신 번호를 버튼으로
 * 늘어놓고 고르면 그 번호로 `AddProblemFlow` 가 열린다(`presetNumber`).
 *
 * **번호를 여러 개 한꺼번에 고른다.** 예전에는 한 번에 하나씩만 골라서, 한
 * 문제를 올릴 때마다 목록으로 돌아와 다시 눌러야 했다("하나씩 노가다로 다시
 * 들어가서 눌러서 올리고"). 지금은 고른 번호들이 줄을 서고 한 문제를 끝내면
 * **곧바로 다음 번호로 넘어간다** — 중간에 목록을 거치지 않는다.
 *
 * **틀리지 않은 번호도 고를 수 있다.** 정답 자동 매핑은 `items` 에서 번호로
 * 찾는 것이라 맞힌 문항에도 똑같이 된다. 그런데 예전에는 목록에 틀린 번호만
 * 있어서, 맞힌 문제를 올리려면 "+ 다른 번호 추가"로 번호를 직접 쳐야 했고
 * 그게 연동이 안 되는 것처럼 보였다(사용자 신고).
 */
export default function GradeProblemUploader({
  categoryId,
  canAdd,
  gradeId,
  title,
  wrongNumbers,
  existingNumbers,
  items,
}: Props) {
  /** 고른 번호들. 순서대로 하나씩 올린다. */
  const [queue, setQueue] = useState<number[]>([]);
  /** queue 에서 지금 올리는 중인 자리. */
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [showCorrect, setShowCorrect] = useState(false);
  const [addingCustom, setAddingCustom] = useState(false);
  const [customNumber, setCustomNumber] = useState("");

  const done = useMemo(() => new Set(existingNumbers), [existingNumbers]);
  const remaining = wrongNumbers.filter((n) => !done.has(n));
  const wrongSet = useMemo(() => new Set(wrongNumbers), [wrongNumbers]);
  /** 맞힌 번호(정답은 items 에 있으므로 이쪽도 자동 매핑된다). */
  const correctNumbers = (items ?? [])
    .map((it) => it.no)
    .filter((n) => !wrongSet.has(n) && !done.has(n))
    .sort((a, b) => a - b);

  // 문항별 상세가 없는 옛 채점 기록(items 도입 전에 저장됨) — 정답 자동
  // 매핑을 할 재료 자체가 없다. 조용히 빈 칸으로 두면 "연동이 안 된다"로
  // 보이므로 이유를 알린다.
  const noItems = !items || items.length === 0;
  const answerFor = (no: number) => items?.find((it) => it.no === no)?.correctAnswer;

  function toggle(n: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  function start(numbers: number[]) {
    if (numbers.length === 0) return;
    setQueue(numbers);
    setCursor(0);
    setPicked(new Set());
  }

  if (cursor < queue.length) {
    const active = queue[cursor];
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <p className="text-sm font-medium text-blue-900">
            {active}번 올리는 중
            {queue.length > 1 && (
              <span className="ml-1 font-normal text-blue-700">
                ({cursor + 1}/{queue.length})
              </span>
            )}
            {queue.length > 1 && cursor + 1 < queue.length && (
              <span className="ml-2 text-xs font-normal text-blue-600">
                다음: {queue.slice(cursor + 1).join(", ")}번
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => {
              setQueue([]);
              setCursor(0);
            }}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            그만두기
          </button>
        </div>
        <AddProblemFlow
          // 번호가 바뀔 때마다 완전히 새로 시작해야 한다(이전 번호의 큐·결과가
          // 섞이면 안 된다) — key로 강제 재마운트한다.
          key={active}
          categoryId={categoryId}
          canAdd={canAdd}
          presetNumber={active}
          presetAnswer={answerFor(active)}
          gradeId={gradeId}
          // 한 문제를 끝내면 목록으로 돌아가지 않고 곧바로 다음 번호로 간다.
          onDone={() => setCursor((c) => c + 1)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
      <div>
        {title && <p className="text-xs font-medium text-blue-700">{title}</p>}
        <p className="text-sm font-medium text-blue-900">
          채점 결과 틀린 문제: {wrongNumbers.length > 0 ? wrongNumbers.join(", ") : "없음"}
        </p>
      </div>

      {noItems && (
        <p className="text-xs text-amber-700">
          이 채점 기록은 문항별 정답을 따로 저장하지 않은 예전 것이라 정답
          자동 매핑이 안 돼요 — 정답을 직접 입력해주세요.
        </p>
      )}

      {remaining.length > 0 ? (
        <>
          <p className="text-sm text-blue-800">
            올릴 번호를 고르세요 — 여러 개를 한꺼번에 고르면 순서대로 이어서
            올립니다.
          </p>
          <div className="flex flex-wrap gap-2">
            {remaining.map((n) => {
              const on = picked.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  disabled={!canAdd}
                  aria-pressed={on}
                  onClick={() => toggle(n)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                    on
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-blue-400 bg-white text-blue-700 hover:bg-blue-100"
                  }`}
                >
                  {n}번
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-sm text-emerald-700">
          틀린 문제를 전부 오답으로 올렸어요.
        </p>
      )}

      {/* 맞힌 문항도 올릴 수 있다 — 정답은 똑같이 자동으로 채워진다.
          기본으로 접어 두는 것은 대개 틀린 것만 올리기 때문이다. */}
      {correctNumbers.length > 0 && (
        <div>
          {!showCorrect ? (
            <button
              type="button"
              onClick={() => setShowCorrect(true)}
              className="text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800"
            >
              + 맞힌 번호도 올리기 ({correctNumbers.length}개) — 정답은 그대로 연동돼요
            </button>
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-blue-700">맞힌 번호 (정답 자동 연동)</p>
              <div className="flex flex-wrap gap-1.5">
                {correctNumbers.map((n) => {
                  const on = picked.has(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={!canAdd}
                      aria-pressed={on}
                      onClick={() => toggle(n)}
                      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                        on
                          ? "border-slate-600 bg-slate-600 text-white"
                          : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      {n}번
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {picked.size > 0 && (
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => start([...picked].sort((a, b) => a - b))}
          className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          고른 {picked.size}개 올리기
        </button>
      )}

      {!addingCustom ? (
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => setAddingCustom(true)}
          className="self-start text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800 disabled:opacity-40"
        >
          + 다른 번호 추가
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="number"
            min={1}
            value={customNumber}
            onChange={(e) => setCustomNumber(e.target.value)}
            placeholder="문제 번호"
            className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={!customNumber.trim()}
            onClick={() => {
              const n = Number(customNumber);
              if (Number.isFinite(n) && n > 0) start([n]);
              setAddingCustom(false);
              setCustomNumber("");
            }}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            추가
          </button>
          <button
            type="button"
            onClick={() => {
              setAddingCustom(false);
              setCustomNumber("");
            }}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            취소
          </button>
        </div>
      )}

      {!canAdd && (
        <p className="text-xs text-amber-700">
          토큰을 모두 사용해 오답을 더 추가할 수 없어요.
        </p>
      )}
    </div>
  );
}
