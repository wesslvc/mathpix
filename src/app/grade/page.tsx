import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import Logo from "@/components/Logo";
import GradeExamFlow from "@/components/GradeExamFlow";

export default async function GradePage() {
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <Logo size={40} />
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Supabase 설정이 아직 완료되지 않았습니다.
        </p>
      </main>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
        <p className="text-sm text-slate-500">
          로그인이 필요합니다.{" "}
          <Link href="/login" className="text-blue-600 underline">
            로그인 페이지로 이동
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline"
        >
          ← 목록으로
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-ink">자동채점</h1>
        <p className="mt-1 text-sm text-slate-500">
          OMR 카드와 정답표 사진을 올리면 채점해드려요. 정답표에 배점이 없으면
          틀린 번호만 알려드립니다.
        </p>
      </header>

      <GradeExamFlow />
    </main>
  );
}
