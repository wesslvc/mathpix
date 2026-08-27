"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * 국어 채점 기록의 시험지 전체 메모.
 *
 * 국어는 지문이 여러 문항에 걸쳐 있어 "문제 하나 사진"이라는 오답추가
 * 단위와 안 맞는다(사용자가 명시적으로 국어는 문항별 오답 없이 이것만
 * 있으면 된다고 정했다). 그래서 문항별이 아니라 **시험지 전체**에 대한
 * 자유 메모 하나만 둔다.
 *
 * 칸을 벗어날 때 저장한다(타이핑마다 저장하면 왕복이 너무 잦다).
 */
export default function CommentBox({
  examScoreId,
  value,
  onSaved,
}: {
  examScoreId: string;
  value: string;
  onSaved: (comment: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    if (draft === value) return; // 안 바뀌었으면 왕복하지 않는다.
    setSaving(true);
    try {
      const supabase = createClient();
      await supabase
        .from("exam_scores")
        .update({ comment: draft.trim() || null })
        .eq("id", examScoreId);
      onSaved(draft);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-500">메모(시험지 전체)</label>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        placeholder="예: 3문단 독해가 오래 걸림, 문학 파트 시간 부족"
        rows={2}
        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      {saving && <span className="text-xs text-slate-400">저장 중...</span>}
      {!saving && savedAt !== null && (
        <span className="text-xs text-emerald-600">저장됨</span>
      )}
    </div>
  );
}
