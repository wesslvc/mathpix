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
import { getAccessState, isCheckoutReady } from "@/lib/billing";
import { toAnswerType } from "@/lib/answer";

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
        <p className="rounded-lg border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
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
          <h1 className="mt-1 text-2xl font-bold text-ink dark:text-[#e8eaed]">
            {categoryLabel(category)}
          </h1>
          <p className="text-sm text-slate-500 dark:text-[#9aa0a6]">
            문제 {problems?.length ?? 0}개 저장됨
          </p>
        </div>
        <Link
          href={`/export?ids=${category.id}`}
          className="shrink-0 rounded-lg border border-slate-300 dark:border-[#4a4d51] bg-white dark:bg-[#1f1f1f] px-4 py-2 text-sm font-medium text-ink dark:text-[#e8eaed] hover:bg-slate-50 dark:hover:bg-[#2a2b2e]"
        >
          PDF 만들기
        </Link>
      </header>

      <BillingStatus
        credits={access.credits}
        unlimited={access.unlimited}
        checkoutReady={isCheckoutReady()}
      />

      <AddProblemFlow categoryId={category.id} canAdd={access.canRecognize} />

      <ProblemGallery problems={galleryProblems} />
    </main>
  );
}
