"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { categoryLabel, type Category } from "@/lib/supabase/types";
import DeleteCategoryButton from "@/components/DeleteCategoryButton";

export default function CategoryList({
  categories,
}: {
  categories: Category[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportSelected() {
    const ids = categories
      .filter((c) => selected.has(c.id))
      .map((c) => c.id);
    if (ids.length === 0) return;
    router.push(`/export?ids=${ids.join(",")}`);
  }

  if (categories.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        아직 등록된 실모가 없습니다. 위에서 실모를 추가해보세요.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          여러 실모를 체크하면 오답을 한 번에 PDF로 모을 수 있습니다.
        </p>
        <button
          type="button"
          onClick={exportSelected}
          disabled={selected.size === 0}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          선택한 {selected.size || ""}개로 PDF 만들기
        </button>
      </div>

      {categories.map((category) => (
        <div
          key={category.id}
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm"
        >
          <input
            type="checkbox"
            checked={selected.has(category.id)}
            onChange={() => toggle(category.id)}
            className="h-4 w-4 shrink-0 rounded border-slate-300"
            aria-label="선택"
          />
          <Link
            href={`/categories/${category.id}`}
            className="min-w-0 flex-1"
          >
            <p className="truncate font-semibold text-ink">
              {categoryLabel(category)}
              {category.is_exam && (
                <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                  실모
                </span>
              )}
            </p>
            <p className="text-xs text-slate-400">
              {new Date(category.created_at).toLocaleDateString("ko-KR")} 생성
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-3">
            <DeleteCategoryButton
              categoryId={category.id}
              label={categoryLabel(category)}
            />
            <Link
              href={`/categories/${category.id}`}
              className="text-sm text-blue-600"
            >
              열기 →
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
