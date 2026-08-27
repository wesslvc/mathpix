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
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        + 실모 추가
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <input
        autoFocus
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="출처 (예: 강대모의고사 2회, 2025학년도 6월 모의평가)"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
              className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
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
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
      </div>

      {isExam && score.trim() !== "" && (
        <p className="text-xs text-slate-400">
          출처는 <span className="font-medium text-slate-600">
            {source.trim() || "출처"}({score.trim()}/100)
          </span> 로 표시됩니다.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            reset();
            setIsOpen(false);
          }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          취소
        </button>
        <button
          type="submit"
          disabled={isSubmitting || !source.trim()}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isSubmitting ? "추가 중..." : "추가"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
