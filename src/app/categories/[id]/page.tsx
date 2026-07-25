import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Category, Problem } from "@/lib/supabase/types";
import AddProblemFlow from "@/components/AddProblemFlow";
import ExportPdfButton from "@/components/ExportPdfButton";

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
    .order("created_at", { ascending: false })
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

  const imageUrls = (problems ?? [])
    .map((p) => signedUrlByPath.get(p.image_path))
    .filter((url): url is string => Boolean(url));

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-blue-600 underline">
            ← 목록으로
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-ink">{category.source}</h1>
          <p className="text-sm text-slate-500">
            문제 {problems?.length ?? 0}개 저장됨
          </p>
        </div>
        <ExportPdfButton source={category.source} imageUrls={imageUrls} />
      </header>

      <AddProblemFlow categoryId={category.id} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {(problems ?? []).map((problem) => {
          const url = signedUrlByPath.get(problem.image_path);
          if (!url) return null;
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={problem.id}
              src={url}
              alt="저장된 오답"
              className="w-full rounded-lg border border-slate-200 bg-white object-contain shadow-sm"
            />
          );
        })}
      </div>

      {(problems ?? []).length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
          아직 저장된 오답이 없습니다. 위에서 오답을 추가해보세요.
        </p>
      )}
    </main>
  );
}
