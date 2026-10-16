import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Category, ExamScore, Folder } from "@/lib/supabase/types";
import Link from "next/link";
import { buildTrendSeries } from "@/lib/scoreTrend";
import ScoreTrendChart from "@/components/ScoreTrendChart";
import { examMaxScore, type Subject } from "@/lib/gradeSummary";
import NewCategoryForm from "@/components/NewCategoryForm";
import LogoutButton from "@/components/LogoutButton";
import CategoryList from "@/components/CategoryList";
import Landing from "@/components/Landing";
import BillingStatus from "@/components/BillingStatus";
import Logo from "@/components/Logo";
import { VARIANT_FOLDER_ID } from "@/lib/variantFolder";
import { getAccessState, isByokCheckoutReady, isCheckoutReady } from "@/lib/billing";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const { folder: currentFolderId } = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
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

  // 로그아웃 상태에서는 **공개 소개 화면**을 보여준다. 예전에는 미들웨어가
  // 여기까지 오기 전에 `/login` 으로 보냈고, 그래서 검색 엔진이 색인할 내용이
  // 이 사이트에 하나도 없었다(`Landing` 주석 참고).
  if (!user) return <Landing />;

  // **넷을 한꺼번에 부른다.** 서로 필요로 하는 게 없는데 예전에는 `await` 를
  // 네 줄로 늘어놓아 왕복 네 번이 **차례로** 일어났다 — Vercel↔Supabase 한
  // 번이 수십~수백 ms 라 그대로 화면 뜨는 시간에 더해졌다. 한 번에 보내면
  // 가장 느린 하나만큼만 걸린다.
  const [
    { data: allCategories },
    { data: realFolders },
    { data: linked },
    access,
  ] = await Promise.all([
    supabase
      .from("categories")
      .select("*")
      .order("created_at", { ascending: false })
      .returns<(Category & { is_variant?: boolean })[]>(),
    supabase
      .from("folders")
      .select("*")
      .order("created_at", { ascending: true })
      .returns<Folder[]>(),
    // 실모 라벨의 만점(탐구 50 / 그 밖 100)은 연결된 채점 기록의 과목에서
    // 온다 — categories 자체에는 과목이 없다. 성적 추세도 같은 결과로 그린다(왕복 하나).
    supabase
      .from("exam_scores")
      .select("*")
      .order("taken_at", { ascending: true })
      .order("elective_slot", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .returns<ExamScore[]>(),
    getAccessState(supabase),
  ]);

  // **변형문제 묶음도 일반 목록에서 본다**(사용자 요청 — "일반폴더에서 변형문제 볼수있게").
  // 묶음(`is_variant`)은 가짜 폴더 하나("변형문제")에 모아 보여 준다 — 그러면 폴더 안에서
  // 열기·검색·선택해서 PDF 내보내기가 실모와 똑같이 된다. 실제 폴더 행이 아니라서
  // 이름 바꾸기·삭제·옮기기는 막는다(CategoryList 의 VARIANT_FOLDER_ID).
  const categories = (allCategories ?? []).map((c) =>
    c.is_variant ? { ...c, folder_id: VARIANT_FOLDER_ID } : c,
  );
  const variantCount = categories.filter((c) => c.folder_id === VARIANT_FOLDER_ID).length;
  const folders: Folder[] = [
    ...(realFolders ?? []),
    ...(variantCount > 0
      ? [{ id: VARIANT_FOLDER_ID, user_id: "", name: "변형문제", created_at: "9999-12-31" }]
      : []),
  ];

  // 시행일(없으면 만든 날) 최신순 — 추가한 날이 아니라 실제 응시일 기준이다(6모는 맨 아래로).
  const dayOf = (c: Category) => (c.exam_date ?? c.created_at).slice(0, 10);
  categories.sort((a, b) => {
    const d = dayOf(b).localeCompare(dayOf(a));
    return d !== 0 ? d : b.created_at.localeCompare(a.created_at);
  });

  const maxScoreByCategory: Record<string, number> = {};
  for (const row of linked ?? []) {
    if (row.category_id) maxScoreByCategory[row.category_id] = examMaxScore(row.subject);
  }
  const series = buildTrendSeries(linked ?? []);
  const gradeSeries = buildTrendSeries(linked ?? [], "grade");

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pb-10 pt-6">
      {/* **자동채점·프로필 및 설정·정답표 생성기 버튼을 없앴다**(사용자
          지적 — "중복되는 버튼들이 상단에 너무 자리차지"). 전역
          내비게이션(`AppNav`)에 채점·프로필 및 설정·정답표 링크가 이미
          있어서, 여기 있던 셋은 같은 곳으로 가는 버튼이 위아래로 두 번
          찍히고 있었다. 로그아웃만 여기 고유한 동작이라 남긴다. */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink">내 실모</h1>
          <p className="mt-1 text-sm text-slate-500">
            실모(출처)별로 오답을 모아두고, 나중에 한 번에 PDF로 인쇄하세요.
          </p>
        </div>
        {/* 잔량은 한 줄로 — 매번 보는 화면이라 배너 두 개가 위를 차지하면 목록이
            밀려난다. 바닥났을 때만 눈에 띄는 배너가 된다(BillingStatus 참고). */}
        <div className="flex items-center gap-3">
          <BillingStatus
            compact
            credits={access.credits}
            unlimited={access.unlimited}
            byok={access.byok}
            checkoutReady={isCheckoutReady()}
            byokCheckoutReady={isByokCheckoutReady()}
          />
          <LogoutButton />
        </div>
      </header>

      <NewCategoryForm folderId={currentFolderId && currentFolderId !== VARIANT_FOLDER_ID ? currentFolderId : null} />

      <CategoryList
        maxScoreByCategory={maxScoreByCategory}
        categories={categories}
        folders={folders}
        currentFolderId={currentFolderId ?? null}
      />

      {/* 성적 추세도 홈에서 같이 본다(성적 탭 분리, 2026-10-14). 기록이 없으면 안 그린다. */}
      {(series.length > 0 || gradeSeries.length > 0) && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">최근 성적</h2>
            <Link href="/scores" className="text-xs font-medium text-blue-700 hover:underline">
              성적 전체 보기 →
            </Link>
          </div>
          <ScoreTrendChart series={series} gradeSeries={gradeSeries} compact />
        </section>
      )}
    </main>
  );
}
