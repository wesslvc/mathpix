import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Category, Folder } from "@/lib/supabase/types";
import { examMaxScore, type Subject } from "@/lib/gradeSummary";
import NewCategoryForm from "@/components/NewCategoryForm";
import LogoutButton from "@/components/LogoutButton";
import CategoryList from "@/components/CategoryList";
import BillingStatus from "@/components/BillingStatus";
import Logo from "@/components/Logo";
import { getAccessState, isCheckoutReady } from "@/lib/billing";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const { folder: currentFolderId } = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <Logo size={44} />
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

  const { data: folders } = await supabase
    .from("folders")
    .select("*")
    .order("created_at", { ascending: true })
    .returns<Folder[]>();

  // 실모 라벨의 만점(탐구 50 / 그 밖 100)은 연결된 채점 기록의 과목에서
  // 온다 — categories 자체에는 과목이 없다. 없으면 100으로 두면 예전 표기
  // 그대로다.
  const { data: linked } = await supabase
    .from("exam_scores")
    .select("category_id, subject")
    .not("category_id", "is", null)
    .returns<{ category_id: string; subject: Subject }[]>();
  const maxScoreByCategory: Record<string, number> = {};
  for (const row of linked ?? []) {
    maxScoreByCategory[row.category_id] = examMaxScore(row.subject);
  }

  const access = await getAccessState(supabase);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Logo size={44} />
          <p className="mt-2 text-sm text-slate-500">
            실모(출처)별로 오답을 모아두고, 나중에 한 번에 PDF로 인쇄하세요.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/grade"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
          >
            자동채점
          </Link>
          {/* 채점 기록(개별 시행 검색)과 성적 추세를 한 화면(/profile)으로
              합쳤다 — 예전엔 두 링크로 나뉘어 있었다. */}
          <Link
            href="/profile"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50"
          >
            채점 기록·추세
          </Link>
          <LogoutButton />
        </div>
      </header>

      <BillingStatus
        credits={access.credits}
        unlimited={access.unlimited}
        checkoutReady={isCheckoutReady()}
      />

      <NewCategoryForm folderId={currentFolderId ?? null} />

      <CategoryList
          maxScoreByCategory={maxScoreByCategory}
        categories={categories ?? []}
        folders={folders ?? []}
        currentFolderId={currentFolderId ?? null}
      />
    </main>
  );
}
