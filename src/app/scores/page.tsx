import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { ExamScore } from "@/lib/supabase/types";
import { buildTrendSeries } from "@/lib/scoreTrend";
import ScoreTrendChart from "@/components/ScoreTrendChart";
import GradeHistoryList from "@/components/GradeHistoryList";
import ManualScoreForm from "@/components/ManualScoreForm";
import Logo from "@/components/Logo";
import { buttonVariants } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 성적 화면 — 추세 · 직접 입력 · 채점 기록.
 * 예전에는 /profile 안에 설정과 섞여 있었는데(길어서 설정을 찾기 어려웠다) 따로 뺐다.
 */
export default async function ScoresPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
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
      <main className="mx-auto flex max-w-md flex-col items-center justify-center px-4 text-center">
        <p className="text-sm text-slate-500">
          로그인이 필요합니다.{" "}
          <Link href="/login" className="text-blue-600 underline">
            로그인 페이지로 이동
          </Link>
        </p>
      </main>
    );
  }

  const { data: scores } = await supabase
    .from("exam_scores")
    .select("*")
    .order("taken_at", { ascending: true })
    // 같은 날 같은 시험의 1선택·2선택은 2선택이 더 나중 기록이다.
    .order("elective_slot", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .returns<ExamScore[]>();

  const series = buildTrendSeries(scores ?? []);
  const gradeSeries = buildTrendSeries(scores ?? [], "grade");
  // 추세는 시간순, 기록 목록은 최근 것부터 — 같은 결과를 뒤집어 재사용한다.
  const historyRows = [...(scores ?? [])].reverse();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-10 pt-6">
      <header className="flex items-end justify-between gap-2">
        <h1 className="text-xl font-semibold text-ink">성적</h1>
        <Link href="/grade" className={buttonVariants({ variant: "ghost", size: "xs", className: "text-blue-700" })}>
          자동채점 →
        </Link>
      </header>

      <section className="flex flex-col gap-3">
        {series.length === 0 && gradeSeries.length === 0 ? (
          <p className={cn(cardClass, "px-4 py-6 text-center text-sm text-slate-400")}>
            아직 성적 기록이 없어요. 자동채점을 하거나 아래에서 성적을 직접
            적어 넣으면 여기에 추세가 쌓입니다.
          </p>
        ) : (
          <ScoreTrendChart series={series} gradeSeries={gradeSeries} />
        )}
        <ManualScoreForm />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-ink">채점 기록</h2>
        <GradeHistoryList rows={historyRows} />
      </section>
    </main>
  );
}
