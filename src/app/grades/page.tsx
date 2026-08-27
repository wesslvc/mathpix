import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import Logo from "@/components/Logo";
import GradeHistoryList, {
  type GradeHistoryRow,
} from "@/components/GradeHistoryList";

export default async function GradesPage() {
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

  // 목록에는 문항별 상세(items)를 뺀다 — 세부오답은 상세 페이지에서만 필요하고,
  // 기록이 쌓일수록 목록 하나 여는 데 읽는 양이 불필요하게 늘어난다.
  const { data: rows } = await supabase
    .from("exam_scores")
    .select(
      "id, subject, elective_slot, elective_label, exam_name, taken_at, score, grade_level, wrong_numbers",
    )
    .order("taken_at", { ascending: false })
    .returns<GradeHistoryRow[]>();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      <header>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline"
        >
          ← 목록으로
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-ink">채점 기록</h1>
        <p className="mt-1 text-sm text-slate-500">
          눌러서 문항별 세부오답을 볼 수 있어요.
        </p>
      </header>

      <GradeHistoryList rows={rows ?? []} />
    </main>
  );
}
