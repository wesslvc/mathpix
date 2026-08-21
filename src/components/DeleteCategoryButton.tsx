"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { thumbPathFor } from "@/lib/cardThumb";

type Props = {
  categoryId: string;
  label: string;
};

export default function DeleteCategoryButton({ categoryId, label }: Props) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    // 카드 전체가 링크이므로 삭제 클릭이 페이지 이동으로 이어지지 않게 막는다.
    e.preventDefault();
    e.stopPropagation();

    if (!window.confirm(`"${label}" 실모를 삭제할까요? 저장된 오답도 함께 삭제됩니다.`)) {
      return;
    }

    setIsDeleting(true);
    try {
      const supabase = createClient();

      // 저장된 오답 이미지(Storage 오브젝트)를 먼저 정리한다.
      const { data: problems } = await supabase
        .from("problems")
        .select("image_path")
        .eq("category_id", categoryId);

      const paths = (problems ?? []).map((p) => p.image_path);
      if (paths.length > 0) {
        // 목록용 미리보기도 같이 지운다 — 안 지우면 아무도 안 보는 파일이
        // 저장 용량만 차지한다(없는 것을 지우라고 해도 오류가 아니다).
        await supabase.storage
          .from("problem-images")
          .remove([...paths, ...paths.map(thumbPathFor)]);
      }

      // problems 행은 on delete cascade로 함께 삭제된다.
      const { error } = await supabase
        .from("categories")
        .delete()
        .eq("id", categoryId);
      if (error) throw error;

      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "삭제에 실패했습니다.");
      setIsDeleting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isDeleting}
      aria-label="실모 삭제"
      className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
    >
      {isDeleting ? "삭제 중..." : "삭제"}
    </button>
  );
}
