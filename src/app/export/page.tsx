import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { categoryLabel, type Category, type Problem } from "@/lib/supabase/types";
import { parseProblemNumber } from "@/lib/problemNumber";
import { formatAnswer, toAnswerType } from "@/lib/answer";
import ExportComposer, {
  type ComposerProblem,
} from "@/components/ExportComposer";

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  const idList = (ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
        <p className="rounded-lg border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          Supabase 설정이 아직 완료되지 않았습니다.
        </p>
      </main>
    );
  }

  if (idList.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-10">
        <p className="text-sm text-slate-500 dark:text-[#9aa0a6]">
          출력할 실모를 선택하지 않았습니다.{" "}
          <Link href="/" className="text-blue-600 dark:text-blue-300 underline">
            목록으로 돌아가기
          </Link>
        </p>
      </main>
    );
  }

  const supabase = await createClient();

  const { data: categories } = await supabase
    .from("categories")
    .select("*")
    .in("id", idList)
    .returns<Category[]>();

  const categoryById = new Map((categories ?? []).map((c) => [c.id, c]));

  const { data: problems } = await supabase
    .from("problems")
    .select("*")
    .in("category_id", idList)
    .returns<Problem[]>();

  // 선택한 실모 순서대로, 각 실모 안에서는 sort_order 순으로 정렬.
  const ordered = (problems ?? []).slice().sort((a, b) => {
    const ai = idList.indexOf(a.category_id);
    const bi = idList.indexOf(b.category_id);
    if (ai !== bi) return ai - bi;
    const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.created_at.localeCompare(b.created_at);
  });

  const paths = ordered.map((p) => p.image_path);
  const signedUrlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("problem-images")
      .createSignedUrls(paths, 60 * 60);
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) signedUrlByPath.set(s.path, s.signedUrl);
    }
  }

  const composerProblems: ComposerProblem[] = ordered
    .map((p) => {
      const imageUrl = signedUrlByPath.get(p.image_path);
      if (!imageUrl) return null;
      const cat = categoryById.get(p.category_id);
      return {
        id: p.id,
        imageUrl,
        source: cat ? categoryLabel(cat) : "출처",
        // 점수를 뺀 출처. 같은 출처가 여러 페이지에 걸칠 때 점수를 반복하지 않는다.
        sourceBase: cat?.source ?? "출처",
        origNumber: parseProblemNumber(p.text_content || p.latex || ""),
        // 객관식이면 "1" -> "①"로 바꿔 정답표에 찍는다. 저장은 원문 그대로이고
        // 변환은 표시할 때만 한다(유형을 바꾸면 되돌아가야 하므로).
        answer: formatAnswer(p.answer, toAnswerType(p.answer_type)),
      };
    })
    .filter((p): p is ComposerProblem => p !== null);

  const multi = idList.length > 1;
  const firstCategory = categories?.find((c) => c.id === idList[0]);
  const defaultTitle =
    !multi && firstCategory ? categoryLabel(firstCategory) : "";

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // 단일 선택이면 그 실모의 시행일, 복수 선택이면 오늘(모음 만드는 날)로.
  const examDate =
    !multi && firstCategory?.exam_date ? firstCategory.exam_date : todayIso;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <header>
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline">
          ← 목록으로
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-ink dark:text-[#e8eaed]">PDF 만들기</h1>
        <p className="text-sm text-slate-500 dark:text-[#9aa0a6]">
          실모 {idList.length}개 · 문제 {composerProblems.length}개
        </p>
      </header>

      {composerProblems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 dark:border-[#4a4d51] px-4 py-8 text-center text-sm text-slate-500 dark:text-[#9aa0a6]">
          선택한 실모에 저장된 오답이 없습니다.
        </p>
      ) : (
        <ExportComposer
          multi={multi}
          defaultTitle={defaultTitle}
          examDate={examDate}
          problems={composerProblems}
        />
      )}
    </main>
  );
}
