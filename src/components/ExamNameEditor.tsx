"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * 채점 기록의 이름(`exam_scores.exam_name`)을 그 자리에서 붙이거나 고친다.
 *
 * 채점 화면 맨 위(설정 단계)에서도 적을 수 있지만, 안 적고 넘어가면 그
 * 뒤로는 "1선택 · 세계지리"처럼 과목명만 목록에 뜬다 — 시험이 여러 번
 * 쌓이면 어느 게 어느 시험인지 구분이 안 된다는 요청이었다. 저장이 끝난
 * 뒤(채점 완료 화면·기록 상세 화면)에도 붙일 수 있게 별도로 뒀다.
 *
 * CategoryTitleEditor와 같은 "눌러서 고치기" 패턴이다. 다만 여기는 서버
 * 컴포넌트를 라우터로 새로고침하는 대신 **자기 안에서 표시값을 들고
 * 있는다** — 호출하는 쪽(채점 완료 화면의 로컬 state, 상세 페이지의 헤더)
 * 마다 반영 방식이 달라서, 그 결정을 여기서 미리 정해두지 않는다.
 */
export default function ExamNameEditor({
  examScoreId,
  value,
  categoryId = null,
  onSaved,
}: {
  examScoreId: string;
  value: string;
  /**
   * 연결된 실모(카테고리) id. 있으면 시험 이름을 바꿀 때 실모 제목도
   * 자동으로 같이 맞춘다 — 같은 시험을 가리키는 두 이름이 서로 달라지지
   * 않게 하려는 것이다(사용자 요청).
   */
  categoryId?: string | null;
  /**
   * **선택.** 서버 컴포넌트(예: `/grades/[id]` 페이지)에서 이 컴포넌트를
   * 쓸 때는 아예 넘기지 마세요 — 서버 컴포넌트는 함수를 클라이언트
   * 컴포넌트 prop으로 내려줄 수 없어서("Event handlers cannot be passed
   * to Client Component props" 런타임 에러가 난다) `() => {}`조차 안 된다.
   * 클라이언트 컴포넌트(채점 완료 화면 등)에서만 실제 콜백을 넘기세요.
   */
  onSaved?: (name: string) => void;
}) {
  const [name, setName] = useState(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = draft.trim();
    if (next === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase
        .from("exam_scores")
        .update({ exam_name: next || null })
        .eq("id", examScoreId);
      if (err) throw err;
      // 연결된 실모가 있으면 제목도 자동으로 맞춘다. 이름을 비우는 건
      // "이 시험 이름을 없앰"이지 "실모 제목까지 지움"이 아니므로, 비게
      // 만들 때는 실모 쪽을 건드리지 않는다.
      if (categoryId && next) {
        await supabase.from("categories").update({ source: next }).eq("id", categoryId);
      }
      setName(next);
      setEditing(false);
      onSaved?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "이름을 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        className="text-left text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600"
      >
        {name.trim() ? name : "+ 시험 이름 붙이기"}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
          }}
          disabled={busy}
          placeholder="예: 2025학년도 9월 모의평가"
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none disabled:opacity-50"
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
            setDraft(name);
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
