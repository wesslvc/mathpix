"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * 실모 제목(출처)을 그 자리에서 고친다.
 *
 * 실모를 만들 때 적은 출처가 곧 제목인데, 오타를 냈거나 나중에 이름을 바꾸고
 * 싶어도 방법이 없었다. 제목을 눌러 바로 고칠 수 있게 한다.
 *
 * **점수는 여기서 건드리지 않는다.** 화면에 보이는 제목(`categoryLabel`)에는
 * 점수가 함께 붙지만 그건 따로 관리되는 값이라, 여기서 같이 고치면 무엇을
 * 바꾸는 중인지 헷갈린다.
 */
export default function CategoryTitleEditor({
  id,
  source,
  label,
  examDate,
}: {
  id: string;
  /** 고칠 값(출처). 화면에 보이는 `label` 과 다를 수 있다(점수가 붙는다). */
  source: string;
  label: string;
  /** 시행일(YYYY-MM-DD). PDF 머리말에 쓰인다 — 잘못 넣으면 고칠 길이 없었다. */
  examDate: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [dateDraft, setDateDraft] = useState(examDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = draft.trim();
    const nextDate = dateDraft.trim() || null;
    const titleChanged = Boolean(next) && next !== source;
    const dateChanged = nextDate !== (examDate ?? null);
    if (!titleChanged && !dateChanged) {
      setEditing(false);
      setDraft(source);
      setDateDraft(examDate ?? "");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase
        .from("categories")
        .update({
          ...(titleChanged ? { source: next } : {}),
          ...(dateChanged ? { exam_date: nextDate } : {}),
        })
        .eq("id", id);
      if (err) throw err;
      // 이 실모에 연결된 채점 기록의 시험 이름도 자동으로 맞춘다 — 실모
      // 제목만 바꾸고 연결된 시험 이름은 그대로 두면 같은 시험을 가리키는
      // 두 이름이 서로 달라진다(사용자 요청). 시행일도 같은 이유로 맞춘다.
      if (titleChanged || dateChanged) {
        await supabase
          .from("exam_scores")
          .update({
            ...(titleChanged ? { exam_name: next } : {}),
            ...(dateChanged && nextDate ? { taken_at: nextDate } : {}),
          })
          .eq("category_id", id);
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "제목을 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold text-ink">{label}</h1>
        {examDate && <span className="text-sm text-slate-500">{examDate}</span>}
        <button
          type="button"
          onClick={() => {
            setDraft(source);
            setDateDraft(examDate ?? "");
            setEditing(true);
          }}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
        >
          제목·날짜 수정
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setDraft(source);
              setEditing(false);
            }
          }}
          disabled={busy}
          autoFocus
          className="w-64 max-w-full rounded-lg border border-slate-300 px-3 py-1.5 text-lg font-bold text-ink focus:border-blue-500 focus:outline-none disabled:opacity-50"
        />
        <input
          type="date"
          value={dateDraft}
          onChange={(e) => setDateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setDateDraft(examDate ?? "");
              setEditing(false);
            }
          }}
          disabled={busy}
          aria-label="시행일"
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-ink focus:border-blue-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "저장 중..." : "저장"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(source);
            setDateDraft(examDate ?? "");
            setEditing(false);
          }}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          취소
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
