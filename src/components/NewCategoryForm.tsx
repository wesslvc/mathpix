"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function NewCategoryForm({
  folderId = null,
}: {
  /** 지금 폴더 안을 보고 있으면 그 폴더로 바로 넣는다(파일탐색기에서 폴더
   * 안에서 새로 만들면 그 폴더에 생기는 것과 같다). */
  folderId?: string | null;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [source, setSource] = useState("");
  const [isExam, setIsExam] = useState(false);
  const [score, setScore] = useState("");
  const [examDate, setExamDate] = useState(todayString());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSource("");
    setIsExam(false);
    setScore("");
    setExamDate(todayString());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!source.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");

      const parsedScore =
        isExam && score.trim() !== "" ? Number(score) : null;
      if (parsedScore !== null && Number.isNaN(parsedScore)) {
        throw new Error("점수는 숫자로 입력해주세요.");
      }

      const { data, error: insertError } = await supabase
        .from("categories")
        .insert({
          user_id: user.id,
          source: source.trim(),
          is_exam: isExam,
          score: parsedScore,
          exam_date: examDate || null,
          folder_id: folderId,
        })
        .select("id")
        .single();

      if (insertError) throw insertError;

      reset();
      setIsOpen(false);
      router.push(`/categories/${data.id}`);
      router.refresh();
    } catch (err) {
      // Supabase 에러는 Error 인스턴스가 아니라 { message, ... } 객체라
      // instanceof만 보면 원인이 묻힌다. message 필드를 직접 꺼내 보여준다.
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : "실모 추가에 실패했습니다.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="g-btn g-btn-primary self-start"
      >
        + 실모 추가
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="g-panel flex w-full flex-col gap-3 p-4 sm:p-5"
    >
      <input
        autoFocus
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="출처 (예: 강대모의고사 2회, 2025학년도 6월 모의평가)"
        className="g-input w-full px-3 py-2 text-sm"
      />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isExam}
            onChange={(e) => setIsExam(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          실전모의고사(실모)
        </label>

        {isExam && (
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            점수
            <input
              type="number"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              placeholder="예: 96"
              className="g-input w-24 px-2 py-1 text-sm"
            />
            <span className="text-slate-400">/ 100</span>
          </label>
        )}

        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          시행일
          <input
            type="date"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
            className="g-input px-2 py-1 text-sm"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            reset();
            setIsOpen(false);
          }}
          className="g-btn g-btn-outline"
        >
          취소
        </button>
        <button
          type="submit"
          disabled={isSubmitting || !source.trim()}
          className="g-btn g-btn-primary"
        >
          {isSubmitting ? "추가 중..." : "추가"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
