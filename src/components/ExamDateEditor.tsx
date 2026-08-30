"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * 채점 기록의 **응시일**(`exam_scores.taken_at`)을 그 자리에서 고친다.
 *
 * 채점할 때 시행일을 고르긴 하지만 기본값이 "오늘"이라, 며칠 지나서 채점하면
 * 실제 응시일과 어긋난 채로 저장된다. 그런데 **성적 추세 그래프의 가로축이
 * 바로 이 날짜다**(`buildTrendSeries`) — 틀리면 점이 엉뚱한 자리에 찍히고,
 * 채점 기록 목록의 날짜별 묶기도 어긋난다. 지금까지 저장 뒤에는 고칠 방법이
 * 아예 없었다.
 *
 * `ExamNameEditor` 와 같은 "눌러서 고치기" 패턴이고, 같은 이유로 표시값을
 * 자기 안에 들고 있는다(호출하는 쪽마다 반영 방식이 다르다).
 */
export default function ExamDateEditor({
  examScoreId,
  value,
  categoryId = null,
  onSaved,
}: {
  examScoreId: string;
  /** YYYY-MM-DD. */
  value: string;
  /**
   * 연결된 실모(카테고리) id. 있으면 실모의 시행일(`exam_date`)도 같이
   * 맞춘다 — 이름을 같이 맞추는 것과 같은 이유로, 같은 시험을 가리키는 두
   * 날짜가 서로 달라지지 않게 한다.
   */
  categoryId?: string | null;
  /**
   * **선택.** 서버 컴포넌트에서는 넘기지 마세요 — 함수를 클라이언트
   * 컴포넌트 prop 으로 내려주면 런타임 에러가 납니다(ExamNameEditor 주석 참고).
   */
  onSaved?: (date: string) => void;
}) {
  const [date, setDate] = useState(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = draft.trim();
    // 날짜를 비우는 건 허용하지 않는다 — taken_at 은 추세 그래프의 가로축이라
    // 없으면 그 기록이 그래프에서 통째로 사라진다.
    if (!next || next === date) {
      setDraft(date);
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase
        .from("exam_scores")
        .update({ taken_at: next })
        .eq("id", examScoreId);
      if (err) throw err;
      if (categoryId) {
        await supabase.from("categories").update({ exam_date: next }).eq("id", categoryId);
      }
      setDate(next);
      setEditing(false);
      onSaved?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "응시일을 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(date);
          setEditing(true);
        }}
        className="text-left text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600"
      >
        응시일 {date} · 수정
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus
          type="date"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setDraft(date);
              setEditing(false);
            }
          }}
          disabled={busy}
          aria-label="응시일"
          className="rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "저장 중..." : "저장"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(date);
            setEditing(false);
          }}
          disabled={busy}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          취소
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
