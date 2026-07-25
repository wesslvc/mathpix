import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { categoryLabel, type Category } from "@/lib/supabase/types";
import NewCategoryForm from "@/components/NewCategoryForm";
import LogoutButton from "@/components/LogoutButton";
import DeleteCategoryButton from "@/components/DeleteCategoryButton";

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-xl font-bold text-ink">수학오답프린트 제작</h1>
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Supabase 설정이 아직 완료되지 않아 로그인/저장 기능을 사용할 수
          없습니다. <code>NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>를 설정해주세요.
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

  const { data: categories } = await supabase
    .from("categories")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<Category[]>();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">수학오답프린트 제작</h1>
          <p className="mt-1 text-sm text-slate-500">
            실모(출처)별로 오답을 모아두고, 나중에 한 번에 PDF로 인쇄하세요.
          </p>
        </div>
        <LogoutButton />
      </header>

      <NewCategoryForm />

      <div className="flex flex-col gap-3">
        {(!categories || categories.length === 0) && (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            아직 등록된 실모가 없습니다. 위에서 실모를 추가해보세요.
          </p>
        )}

        {categories?.map((category) => (
          <Link
            key={category.id}
            href={`/categories/${category.id}`}
            className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm hover:border-blue-400"
          >
            <div>
              <p className="font-semibold text-ink">
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
            </div>
            <div className="flex items-center gap-3">
              <DeleteCategoryButton
                categoryId={category.id}
                label={categoryLabel(category)}
              />
              <span className="text-sm text-blue-600">열기 →</span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
