"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Props = {
  problemId: string;
  imagePath: string;
};

export default function DeleteProblemButton({ problemId, imagePath }: Props) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!window.confirm("이 오답을 삭제할까요?")) return;

    setIsDeleting(true);
    try {
      const supabase = createClient();
      await supabase.storage.from("problem-images").remove([imagePath]);
      const { error } = await supabase.from("problems").delete().eq("id", problemId);
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
      aria-label="오답 삭제"
      className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-slate-900/60 text-sm text-white hover:bg-red-600 disabled:opacity-50"
    >
      {isDeleting ? "…" : "✕"}
    </button>
  );
}
