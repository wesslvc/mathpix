import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getAccessState, isCheckoutReady } from "@/lib/billing";
import type { ExamScore } from "@/lib/supabase/types";
import { buildTrendSeries } from "@/lib/scoreTrend";
import BillingStatus from "@/components/BillingStatus";
import ScoreTrendChart from "@/components/ScoreTrendChart";
import Logo from "@/components/Logo";
import GradeHistoryList from "@/components/GradeHistoryList";

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
  // 추세 그래프는 시간순(오름차순)이 필요하고, 기록 목록은 최근 것부터
  // 보이는 게 자연스럽다 — 같은 쿼리 결과를 뒤집어 재사용한다(왕복을
  // 늘리지 않는다).
  const historyRows = [...(scores ?? [])].reverse();

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
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <ScoreTrendChart series={series} />
          </div>
        )}
      </section>

      {/* 추세(요약)와 기록(개별 시행 검색·상세)을 같은 화면에서 볼 수 있게
          합쳤다 — 예전엔 /grades 와 /profile 로 나뉘어 있어 추세를 보다가
          특정 시험 하나를 찾으려면 화면을 오가야 했다. */}
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-ink">채점 기록</h2>
        <GradeHistoryList rows={historyRows} />
      </section>
    </main>
  );
}
