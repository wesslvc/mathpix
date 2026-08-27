import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getAccessState, isCheckoutReady } from "@/lib/billing";
import type { ExamScore } from "@/lib/supabase/types";
import { buildTrendSeries } from "@/lib/scoreTrend";
import BillingStatus from "@/components/BillingStatus";
import ScoreTrendChart from "@/components/ScoreTrendChart";
import Logo from "@/components/Logo";

export default async function ProfilePage() {
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

  const access = await getAccessState(supabase);
  const { data: scores } = await supabase
    .from("exam_scores")
    .select("*")
    .order("taken_at", { ascending: true })
    .returns<ExamScore[]>();

  const series = buildTrendSeries(scores ?? []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline"
        >
          ← 목록으로
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-ink">내 프로필</h1>
        <p className="mt-1 text-sm text-slate-500">{user.email}</p>
      </header>

      <BillingStatus
        credits={access.credits}
        unlimited={access.unlimited}
        checkoutReady={isCheckoutReady()}
      />

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">성적 추세</h2>
          <Link href="/grade" className="text-sm text-blue-600 hover:underline">
            자동채점 하러 가기
          </Link>
        </div>

        {series.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
            아직 채점 기록이 없어요. 자동채점을 한 번 해보면 여기에 추세가
            쌓입니다.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {series.map((s) => (
              <div key={s.key} className="rounded-xl border border-slate-200 bg-white p-4">
                <ScoreTrendChart series={s} />
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
