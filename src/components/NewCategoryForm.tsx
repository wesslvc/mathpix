"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function NewCategoryForm() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [source, setSource] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      const { data, error: insertError } = await supabase
        .from("categories")
        .insert({ user_id: user.id, source: source.trim() })
        .select("id")
        .single();

      if (insertError) throw insertError;

      setSource("");
      setIsOpen(false);
      router.push(`/categories/${data.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "실모 추가에 실패했습니다.");
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
      className="flex w-full flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center"
    >
      <input
        autoFocus
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="출처 (예: 2025학년도 6월 모의평가)"
        className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(false)}
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
