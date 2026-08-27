"use client";

import { useState } from "react";
import AddProblemFlow from "./AddProblemFlow";
import type { GradedItemRow } from "@/lib/supabase/types";

type Props = {
  categoryId: string;
  canAdd: boolean;
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
 * 자동채점에서 넘어온 오답추가. **번호부터 고르고, 그다음에 사진을 올린다** —
 * 사용자가 확정한 순서다. 그래서 "문제 번호" 칸에 직접 타이핑하는 대신, 아직
 * 안 올린 틀린 번호를 버튼으로 늘어놓고 그중 하나를 고르면 그 번호로
 * `AddProblemFlow`가 열린다(`presetNumber`). 채점이 놓친 번호를 추가로 넣고
 * 싶을 때만 "+ 다른 번호 추가"로 직접 적는다 — 할당된 번호 밖의 값은 이
 * 버튼을 거쳐야만 들어간다.
 */
export default function GradeProblemUploader({
  categoryId,
  canAdd,
  wrongNumbers,
  existingNumbers,
  items,
}: Props) {
  const [activeNumber, setActiveNumber] = useState<number | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const [customNumber, setCustomNumber] = useState("");

  const done = new Set(existingNumbers);
  const remaining = wrongNumbers.filter((n) => !done.has(n));

  if (activeNumber != null) {
    return (
      <AddProblemFlow
        // 번호가 바뀔 때마다 완전히 새로 시작해야 한다(이전 번호의 큐·결과가
        // 섞이면 안 된다) — key로 강제 재마운트한다.
        key={activeNumber}
        categoryId={categoryId}
        canAdd={canAdd}
        presetNumber={activeNumber}
        presetAnswer={items?.find((it) => it.no === activeNumber)?.correctAnswer}
        onDone={() => setActiveNumber(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
      <p className="text-sm font-medium text-blue-900">
        채점 결과 틀린 문제: {wrongNumbers.join(", ")}
      </p>

      {remaining.length > 0 ? (
        <>
          <p className="text-sm text-blue-800">몇 번 문제를 추가할까요?</p>
          <div className="flex flex-wrap gap-2">
            {remaining.map((n) => (
              <button
                key={n}
                type="button"
                disabled={!canAdd}
                onClick={() => setActiveNumber(n)}
                className="rounded-lg border border-blue-400 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40"
              >
                {n}번
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-emerald-700">
          틀린 문제를 전부 오답으로 올렸어요.
        </p>
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
              if (Number.isFinite(n) && n > 0) setActiveNumber(n);
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
