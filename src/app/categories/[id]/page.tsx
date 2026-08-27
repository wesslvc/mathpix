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
import CategoryTitleEditor from "@/components/CategoryTitleEditor";
import { getAccessState, isCheckoutReady } from "@/lib/billing";
import { toAnswerType } from "@/lib/answer";
import { readFontPt } from "@/lib/fontSize";
import { readProblemNumber } from "@/lib/problemNumber";
import { thumbPathFor } from "@/lib/cardThumb";
import type { BoxOverride } from "@/lib/renderMathText";
import type { ExamScore } from "@/lib/supabase/types";
import GradeProblemUploader from "@/components/GradeProblemUploader";

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
  problemNo: number | null;
  /** 미납 토큰. 0보다 크면 잠긴 문제다. */
  debt: number | null;
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
  "problemNo:box_range->number",
  // 미납으로 잠긴 문제. 결제 전에는 목록에서 가리고 PDF 에서도 뺀다.
  "debt:box_range->debt",
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ gradeId?: string }>;
}) {
  const { id } = await params;
  const { gradeId } = await searchParams;

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
        problemNo: (box.number as number | null) ?? null,
      };
    });
  }

  const paths = (problems ?? []).map((p) => p.image_path);

  /** 주어진 경로들을 서명해 map 으로. 실패하면 빈 map 이다. */
  async function sign(list: string[]): Promise<Map<string, string>> {
    if (list.length === 0) return new Map();
    const { data } = await supabase.storage
      .from("problem-images")
      .createSignedUrls(list, 60 * 60);
    return new Map(
      (data ?? [])
        .filter((s): s is typeof s & { signedUrl: string } =>
          Boolean(s.signedUrl),
        )
        .map((s) => [s.path ?? "", s.signedUrl]),
    );
  }

  /**
   * **목록용 작은 미리보기를 따로 서명한다.**
   *
   * 저장된 카드 PNG 는 평균 760kB 인데 이 화면은 그걸 56×40px(목록 보기)이나
   * 320px 안쪽(카드 보기)으로 보여 준다. 20문제짜리 실모를 한 번 여는 데
   * 15MB 를 받고 있었고, 서명 URL 은 열 때마다 주소가 달라져 **브라우저 캐시가
   * 한 번도 안 걸린다** — 들어갈 때마다 전부 다시 받는다.
   *
   * **한 번에 묶어 서명하지 않는다.** 옛 문제에는 미리보기가 없는데, 없는 경로가
   * 섞였을 때 그 요청이 통째로 실패하는지 그 경로만 비는지에 우리 목록 전체가
   * 걸린다(통째로 실패하면 그림이 하나도 안 뜬다). 나눠서 부르면 미리보기 쪽이
   * 어떻게 되든 원본은 영향을 받지 않는다 — 왕복 한 번 값에 그 위험을 없앤다.
   */
  const [signedUrlByPath, thumbUrlByPath] = await Promise.all([
    sign(paths),
    sign(paths.map(thumbPathFor)),
  ]);

  const galleryProblems: GalleryProblem[] = (problems ?? [])
    .map((p): GalleryProblem | null => {
      const imageUrl = signedUrlByPath.get(p.image_path);
      if (!imageUrl) return null;
      return {
        id: p.id,
        imageUrl,
        // 목록·카드에 그릴 작은 그림. 없으면(옛 문제) 화면이 원본을 쓴다.
        thumbUrl: thumbUrlByPath.get(thumbPathFor(p.image_path)) ?? null,
        imagePath: p.image_path,
        text: p.text_content || p.latex || "",
        sortOrder: p.sort_order,
        answer: p.answer ?? "",
        answerType: toAnswerType(p.answer_type),
        boxRange: boxRangeOf(p),
        fontPt: readFontPt({ fontPt: p.fontPt }),
        number: readProblemNumber({ number: p.problemNo }),
        debt: typeof p.debt === "number" && p.debt > 0 ? p.debt : null,
      };
    })
    .filter((p): p is GalleryProblem => p !== null);

  const access = await getAccessState(supabase);

  // 자동채점에서 "틀린문제 오답 업로드하기"로 넘어온 경우. RLS가 이미 본인
  // 것만 걸러 주지만, 다른 실모의 채점 결과가 실려 오는 사고를 막기 위해
  // category_id도 함께 맞춘다.
  const grade = gradeId
    ? (
        await supabase
          .from("exam_scores")
          .select("*")
          .eq("id", gradeId)
          .eq("category_id", id)
          .maybeSingle<ExamScore>()
      ).data
    : null;
  const existingNumbers = galleryProblems
    .map((p) => p.number)
    .filter((n): n is number => n != null);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline"
          >
            ← 목록으로
          </Link>
          <CategoryTitleEditor
            id={category.id}
            source={category.source}
            label={categoryLabel(category)}
          />
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

      {/* 작업 큐(FigureJobsProvider)와 진행 패널은 루트 레이아웃에 있다 —
          목록으로 돌아가도 작업이 계속 돌아야 하기 때문이다.
          자동채점에서 넘어온 경우(gradeId)는 번호부터 고르고 나서 사진을
          올리게 한다 — GradeProblemUploader 가 그 순서를 강제한다. */}
      {grade ? (
        <GradeProblemUploader
          categoryId={category.id}
          canAdd={access.canRecognize}
          wrongNumbers={grade.wrong_numbers}
          existingNumbers={existingNumbers}
          items={grade.items}
        />
      ) : (
        <AddProblemFlow categoryId={category.id} canAdd={access.canRecognize} />
      )}

      <ProblemGallery problems={galleryProblems} />
    </main>
  );
}
