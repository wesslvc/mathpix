"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import LinkCategoryPicker from "./LinkCategoryPicker";

type Props = {
  examScoreId: string;
  categoryId: string | null;
  score: number | null;
  gradeLevel: number | null;
  suggestedSource: string;
  takenAt: string;
  wrongCount: number;
  /** 국어는 이 버튼 자체를 안 보여준다(오답추가 단위와 안 맞는다). */
  showUpload: boolean;
};

/** 채점 기록 상세의 조작부: 등급 고르기 · 실모 연결 · 오답 업로드 이동. */
export default function GradeDetailActions({
  examScoreId,
  categoryId: initialCategoryId,
  score,
  gradeLevel,
  suggestedSource,
  takenAt,
  wrongCount,
  showUpload,
}: Props) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [level, setLevel] = useState<number | null>(gradeLevel);

  async function updateLevel(next: number | null) {
    setLevel(next);
    const supabase = createClient();
    await supabase.from("exam_scores").update({ grade_level: next }).eq("id", examScoreId);
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm text-slate-700">
        등급
        <select
          value={level ?? ""}
          onChange={(e) => void updateLevel(e.target.value === "" ? null : Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">미입력</option>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => (
            <option key={g} value={g}>
              {g}등급
            </option>
          ))}
        </select>
      </label>

      {showUpload && (
        <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
          {categoryId ? (
            <p className="text-xs text-emerald-600">실모에 연결됨</p>
          ) : (
            <LinkCategoryPicker
              examScoreId={examScoreId}
              score={score}
              suggestedSource={suggestedSource}
              takenAt={takenAt}
              onLinked={setCategoryId}
            />
          )}
          {wrongCount > 0 ? (
            <button
              type="button"
              disabled={!categoryId}
              title={categoryId ? undefined : "먼저 실모를 선택하거나 만들어주세요"}
              onClick={() => categoryId && router.push(`/categories/${categoryId}?gradeId=${examScoreId}`)}
              className="self-start rounded-lg border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              틀린문제 오답 업로드하기
            </button>
          ) : (
            <p className="text-xs text-slate-400">틀린 문제가 없어 오답 업로드가 필요 없어요.</p>
          )}
        </div>
      )}
    </div>
  );
}
