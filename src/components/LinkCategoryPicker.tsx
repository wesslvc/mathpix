"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { categoryLabel, type Category } from "@/lib/supabase/types";

type Props = {
  /** 연결할 채점 기록. */
  examScoreId: string;
  /** 실모에 반영할 점수(배점이 없었으면 null — 그때는 categories.score를 안 건드린다). */
  score: number | null;
  /** 새 실모를 만들 때 기본으로 채워 둘 출처(과목명 등). */
  suggestedSource: string;
  /** 채점 시행일. 새 실모를 만들 때 exam_date로 쓴다. */
  takenAt: string;
  /** 연결이 끝나면(또는 바뀌면) 알려준다 — 카테고리 id, 또는 연결 해제면 null. */
  onLinked: (categoryId: string | null) => void;
};

/**
 * 채점 결과를 실모(카테고리)에 **선택적으로** 연결한다.
 *
 * 사용자가 확정한 방향: 연결은 강제가 아니다 — "말 들어달라고 하면 만들고
 * 아니면 패스"(요청하면 만들고, 아니면 그냥 둔다). 그래서 이 컴포넌트는 항상
 * 보이되 아무것도 누르지 않으면 `exam_scores.category_id`가 계속 비어 있다.
 *
 * 연결하면 `categories.score`도 함께 채운다 — **배점이 있어 점수가 있을
 * 때만**. 배점이 없어 `score`가 null이면 이미 그 실모에 손으로 적어 둔
 * 점수를 지울 이유가 없으므로 건드리지 않는다.
 */
export default function LinkCategoryPicker({
  examScoreId,
  score,
  suggestedSource,
  takenAt,
  onLinked,
}: Props) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [newSource, setNewSource] = useState(suggestedSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedTo, setLinkedTo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("categories")
        .select("*")
        .order("created_at", { ascending: false })
        .returns<Category[]>();
      if (!cancelled) setCategories(data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function linkTo(categoryId: string) {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: updErr } = await supabase
        .from("exam_scores")
        .update({ category_id: categoryId })
        .eq("id", examScoreId);
      if (updErr) throw updErr;

      // 배점이 있어 점수가 있을 때만 실모 점수도 함께 채운다.
      if (score !== null) {
        await supabase
          .from("categories")
          .update({ score, is_exam: true })
          .eq("id", categoryId);
      }
      setLinkedTo(categoryId);
      onLinked(categoryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "실모 연결에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function createAndLink() {
    if (!newSource.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");

      const { data, error: insErr } = await supabase
        .from("categories")
        .insert({
          user_id: user.id,
          source: newSource.trim(),
          is_exam: true,
          score,
          exam_date: takenAt,
        })
        .select("id")
        .single();
      if (insErr || !data) throw insErr ?? new Error("실모 생성에 실패했습니다.");
      await linkTo(data.id);
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "실모 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (linkedTo) {
    const cat = categories?.find((c) => c.id === linkedTo);
    return (
      <p className="text-xs text-emerald-600">
        {cat ? categoryLabel(cat) : "실모"}에 연결됨
        <button
          type="button"
          onClick={() => {
            setLinkedTo(null);
            onLinked(null);
          }}
          className="ml-2 text-slate-400 underline underline-offset-2 hover:text-slate-600"
        >
          연결 바꾸기
        </button>
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-500">실모에 연결(선택):</span>
      {!creating ? (
        <>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || !categories}
            className="rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
          >
            <option value="">
              {categories === null ? "불러오는 중..." : "실모 선택"}
            </option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => void linkTo(selected)}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            연결
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(true)}
            className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
          >
            + 새로 만들기
          </button>
        </>
      ) : (
        <>
          <input
            autoFocus
            value={newSource}
            onChange={(e) => setNewSource(e.target.value)}
            placeholder="출처 (예: 2025학년도 6월 모의평가)"
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy || !newSource.trim()}
            onClick={() => void createAndLink()}
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            만들고 연결
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(false)}
            className="text-slate-500 hover:text-slate-700"
          >
            취소
          </button>
        </>
      )}
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
