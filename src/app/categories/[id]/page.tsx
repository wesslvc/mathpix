import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { categoryLabel, type Category } from "@/lib/supabase/types";

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
import type { BoxOverride } from "@/lib/renderMathText";

/**
 * 목록 조회에서 실제로 받아오는 모양.
 *
 * **box_range를 통째로 가져오지 않는다.** 그 안에 그림(figures)이 들어 있고
 * 문제 하나당 수백 KB가 넘을 수 있어서, "*"로 가져오면 실모 하나 여는 데 수
 * MB를 읽게 된다. 목록에 필요한 키만 뽑고, 그림은 "수정"을 열 때 그 문제
 * 하나만 따로 가져온다(ProblemGallery.loadFigures).
 *
 * 박스 범위는 형태가 세 가지다 — 지금 형태(ranges)와 박스를 하나만 만들 수
 * 있던 시절의 옛 값 둘({start,end} / {none:true}). 옛 값을 안 챙기면 그때
 * 손으로 잡아둔 박스가 "자동 감지"로 되돌아가 버린다.
 */
type ProblemListRow = {
  id: string;
  image_path: string;
  latex: string | null;
  text_content: string | null;
  answer: string | null;
  answer_type: string | null;
  sort_order: number | null;
  ranges: { start: number; end: number }[] | null;
  fontPt: number | null;
  boxStart: number | null;
  boxEnd: number | null;
  boxNone: boolean | null;
};

const PROBLEM_LIST_COLUMNS = [
  "id",
  "image_path",
  "latex",
  "text_content",
  "answer",
  "answer_type",
  "sort_order",
  "created_at",
  "ranges:box_range->ranges",
  "fontPt:box_range->fontPt",
  "boxStart:box_range->start",
  "boxEnd:box_range->end",
  "boxNone:box_range->none",
].join(", ");

/** 목록 행에서 조건 박스 값을 되살린다(옛 형태 셋을 모두 받는다). */
function boxRangeOf(p: ProblemListRow): BoxOverride | null {
  if (p.ranges) return { ranges: p.ranges };
  if (p.boxNone) return { none: true };
  if (typeof p.boxStart === "number" && typeof p.boxEnd === "number") {
    return { start: p.boxStart, end: p.boxEnd };
  }
  return null;
}

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

  const slim = await supabase
    .from("problems")
    .select(PROBLEM_LIST_COLUMNS)
    .eq("category_id", id)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .returns<ProblemListRow[]>();

  let problems = slim.data;
  if (slim.error) {
    // JSON 경로 선택이 막힌 환경이면 목록이 통째로 안 나오는 것보다 낫다 —
    // 통째로 가져와서 여기서 추린다(그림까지 읽게 되지만 화면은 뜬다).
    const full = await supabase
      .from("problems")
      .select("*")
      .eq("category_id", id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    problems = (full.data ?? []).map((p) => {
      const box = (p.box_range ?? {}) as Record<string, unknown>;
      return {
        ...(p as unknown as ProblemListRow),
        ranges: (box.ranges as ProblemListRow["ranges"]) ?? null,
        fontPt: (box.fontPt as number | null) ?? null,
        boxStart: (box.start as number | null) ?? null,
        boxEnd: (box.end as number | null) ?? null,
        boxNone: (box.none as boolean | null) ?? null,
      };
    });
  }

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
    .map((p): GalleryProblem | null => {
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
        boxRange: boxRangeOf(p),
        fontPt: readFontPt({ fontPt: p.fontPt }),
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
