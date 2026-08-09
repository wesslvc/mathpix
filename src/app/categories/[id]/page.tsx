import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { categoryLabel, type Category, type Problem } from "@/lib/supabase/types";
import AddProblemFlow from "@/components/AddProblemFlow";
import ProblemGallery, {
  type GalleryProblem,
} from "@/components/ProblemGallery";
import BillingStatus from "@/components/BillingStatus";
import Logo from "@/components/Logo";
import FigureJobsProvider from "@/components/FigureJobsProvider";
import FigureJobsPanel from "@/components/FigureJobsPanel";
import { getAccessState, isCheckoutReady } from "@/lib/billing";
import { toAnswerType } from "@/lib/answer";
import { readFontPt } from "@/lib/fontSize";

export default async function CategoryPage({
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

  const { data: category } = await supabase
    .from("categories")
    .select("*")
    .eq("id", id)
    .single<Category>();

  if (!category) {
    notFound();
  }

  const { data: problems } = await supabase
    .from("problems")
    .select("*")
    .eq("category_id", id)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .returns<Problem[]>();

  const paths = (problems ?? []).map((p) => p.image_path);
  let signedUrlByPath = new Map<string, string>();

  if (paths.length > 0) {
    const { data: signedUrls } = await supabase.storage
      .from("problem-images")
      .createSignedUrls(paths, 60 * 60);

    signedUrlByPath = new Map(
      (signedUrls ?? [])
        .filter((s): s is typeof s & { signedUrl: string } => Boolean(s.signedUrl))
        .map((s) => [s.path ?? "", s.signedUrl]),
    );
  }

  const galleryProblems: GalleryProblem[] = (problems ?? [])
    .map((p) => {
      const imageUrl = signedUrlByPath.get(p.image_path);
      if (!imageUrl) return null;
      return {
        id: p.id,
        imageUrl,
        imagePath: p.image_path,
        text: p.text_content || p.latex || "",
        sortOrder: p.sort_order,
        answer: p.answer ?? "",
        answerType: toAnswerType(p.answer_type),
        boxRange: (p.box_range as GalleryProblem["boxRange"]) ?? null,
        fontPt: readFontPt(p.box_range),
      };
    })
    .filter((p): p is GalleryProblem => p !== null);

  const access = await getAccessState(supabase);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline">
            ← 목록으로
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-ink">
            {categoryLabel(category)}
          </h1>
          <p className="text-sm text-slate-500">
            문제 {problems?.length ?? 0}개 저장됨
          </p>
        </div>
        <Link
          href={`/export?ids=${category.id}`}
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-slate-50"
        >
          PDF 만들기
        </Link>
      </header>

      <BillingStatus
        credits={access.credits}
        unlimited={access.unlimited}
        checkoutReady={isCheckoutReady()}
      />

      {/* AI 그림 작업 큐는 오답 추가 화면 바깥에 둔다 — 작업이 도는 동안
          다음 문제로 넘어가도 계속 돌아야 하기 때문이다. 진행 상황은 화면
          구석에 뜨는 FigureJobsPanel에서 따로 본다. */}
      <FigureJobsProvider>
        <AddProblemFlow categoryId={category.id} canAdd={access.canRecognize} />

        <ProblemGallery problems={galleryProblems} />

        <FigureJobsPanel />
      </FigureJobsProvider>
    </main>
  );
}
