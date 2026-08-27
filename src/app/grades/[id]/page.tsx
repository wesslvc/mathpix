import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { ExamScore } from "@/lib/supabase/types";
import GradeDetailActions from "@/components/GradeDetailActions";

const SUBJECT_LABEL: Record<ExamScore["subject"], string> = {
  korean: "국어",
  math: "수학",
  elective: "탐구",
};

export default async function GradeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
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

  const { data: row } = await supabase
    .from("exam_scores")
    .select("*")
    .eq("id", id)
    .maybeSingle<ExamScore>();

  if (!row) notFound();

  const title =
    (row.subject === "elective" && row.elective_slot ? `${row.elective_slot}선택 · ` : "") +
    SUBJECT_LABEL[row.subject] +
    (row.elective_label ? ` · ${row.elective_label}` : "");
  const scoreText =
    row.score === null
      ? "점수 없음"
      : row.subject === "elective"
        ? `${row.score}/50점`
        : `${row.score}점`;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      <header>
        <Link
          href="/grades"
          className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline"
        >
          ← 채점 기록
        </Link>
        {row.exam_name && <p className="mt-2 text-sm text-slate-400">{row.exam_name}</p>}
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        <p className="text-sm text-slate-500">
          {row.taken_at} · {scoreText}
          {row.wrong_numbers.length > 0 && ` · 틀린 번호: ${row.wrong_numbers.join(", ")}`}
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <GradeDetailActions
          examScoreId={row.id}
          categoryId={row.category_id}
          score={row.score}
          gradeLevel={row.grade_level}
          suggestedSource={row.exam_name || title}
          takenAt={row.taken_at}
          wrongCount={row.wrong_numbers.length}
          showUpload={row.subject !== "korean"}
          isKorean={row.subject === "korean"}
          comment={row.comment}
        />
      </div>

      <section>
        <h2 className="mb-2 text-base font-semibold text-ink">세부오답</h2>
        {!row.items ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
            예전 기록이라 문항별 상세가 없어요. 틀린 번호만 남아 있습니다.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-3 py-2">번호</th>
                  <th className="px-3 py-2">학생답</th>
                  <th className="px-3 py-2">정답</th>
                  <th className="px-3 py-2">배점</th>
                  <th className="px-3 py-2">정오</th>
                </tr>
              </thead>
              <tbody>
                {row.items.map((item) => {
                  const isWrong = row.wrong_numbers.includes(item.no);
                  return (
                    <tr
                      key={item.no}
                      className={`border-b border-slate-100 last:border-0 ${isWrong ? "bg-red-50" : ""}`}
                    >
                      <td className="px-3 py-1.5">{item.no}</td>
                      <td className="px-3 py-1.5">{item.studentAnswer ?? "—"}</td>
                      <td className="px-3 py-1.5">{item.correctAnswer}</td>
                      <td className="px-3 py-1.5">{item.points ?? "—"}</td>
                      <td className={`px-3 py-1.5 ${isWrong ? "text-red-500" : "text-emerald-600"}`}>
                        {isWrong ? "X" : "O"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
