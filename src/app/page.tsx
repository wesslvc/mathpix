import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Category } from "@/lib/supabase/types";
import NewCategoryForm from "@/components/NewCategoryForm";
import LogoutButton from "@/components/LogoutButton";
import CategoryList from "@/components/CategoryList";
import BillingStatus from "@/components/BillingStatus";
import Logo from "@/components/Logo";
import { getAccessState, isCheckoutReady } from "@/lib/billing";

export default async function DashboardPage() {
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
        <LogoutButton />
      </header>

      <BillingStatus
        credits={access.credits}
        unlimited={access.unlimited}
        checkoutReady={isCheckoutReady()}
      />

      <NewCategoryForm />

      <CategoryList categories={categories ?? []} />
    </main>
  );
}
