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
import { parseProblemNumber, readProblemNumber } from "@/lib/problemNumber";
import { thumbPathFor } from "@/lib/cardThumb";
import { signCached } from "@/lib/signedUrls";
import type { BoxOverride } from "@/lib/renderMathText";
import type { ExamScore } from "@/lib/supabase/types";
import { SUBJECT_LABEL } from "@/lib/examSubjects";
import { examMaxScore } from "@/lib/gradeSummary";
import GradeLinkPanel from "@/components/GradeLinkPanel";
import AnswerKeyPanel from "@/components/AnswerKeyPanel";
import ProblemNumberScanner from "@/components/ProblemNumberScanner";
import { readKoreanMeta } from "@/lib/koreanSet";

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
  /** 이 문제가 어느 채점 기록에서 왔는지(exam_scores.id). 수동으로 추가한
   * 문제나 이 기능 이전에 만든 문제는 없다. */
  gradeId: string | null;
  /** 이 문제의 배점. 정해두지 않았으면 null. */
  points: number | null;
  korean: unknown;
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
  "gradeId:box_range->>gradeId",
  "points:box_range->points",
  // 국어 지문·문제 묶음. **지문을 문제로 취급하지 않으려면** 이 값이 필요하다
  // (번호 인식·답지 붙이기에서 지문을 빼야 한다).
  "korean:box_range->korean",
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

  // **서로 기다릴 이유가 없는 것은 한꺼번에 부른다.** 이 화면은 왕복이
  // 여섯 번이나 차례로 일어나고 있었다(실모 → 문제 → 서명 → 권한 → 채점 →
  // 연결된 채점). 그중 실모·문제·권한·연결된 채점·`?gradeId=` 는 서로
  // 독립이라 함께 보낼 수 있다 — 서명만 문제 목록이 있어야 하므로 뒤에 남는다.
  // 왕복 여섯 번이 두 번으로 줄었다.
  const [{ data: category }, slim, access, { data: linkedGrades }, gradeRes] =
    await Promise.all([
      supabase.from("categories").select("*").eq("id", id).single<Category>(),
      supabase
        .from("problems")
        .select(PROBLEM_LIST_COLUMNS)
        .eq("category_id", id)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .returns<ProblemListRow[]>(),
      getAccessState(supabase),
      // 이 실모에 연결된 채점 기록들. exam_scores → categories 쪽 연결은
      // LinkCategoryPicker로 이미 되지만, 반대 방향(실모 화면에서 "이 실모는
      // 어느 채점과 연결돼 있나")을 보여줄 곳이 없었다 — 연동을 양쪽에서
      // 확인할 수 있어야 "연동됐다"는 게 실감난다.
      //
      // **wrong_numbers·items 까지 가져온다.** 예전에는 이름·점수만 가져와서
      // 링크만 보여줬고, 오답 업로더는 `?gradeId=` 를 달고 채점 화면에서 넘어온
      // 경우에만 떴다 — 폴더를 거쳐 실모로 바로 들어오면 연동이 통째로 사라져서
      // 번호도, 정답 자동 매핑도 없었다(사용자 신고). 이제 연결된 채점이 있으면
      // 어디로 들어오든 기본으로 뜬다.
      supabase
        .from("exam_scores")
        .select(
          "id, subject, exam_name, elective_label, score, taken_at, wrong_numbers, items",
        )
        .eq("category_id", id)
        .order("taken_at", { ascending: false })
        .returns<
          Pick<
            ExamScore,
            | "id"
            | "subject"
            | "exam_name"
            | "elective_label"
            | "score"
            | "taken_at"
            | "wrong_numbers"
            | "items"
          >[]
        >(),
      // 자동채점에서 "틀린문제 오답 업로드하기"로 넘어온 경우. RLS가 이미 본인
      // 것만 걸러 주지만, 다른 실모의 채점 결과가 실려 오는 사고를 막기 위해
      // category_id도 함께 맞춘다.
      gradeId
        ? supabase
            .from("exam_scores")
            .select("*")
            .eq("id", gradeId)
            .eq("category_id", id)
            .maybeSingle<ExamScore>()
        : Promise.resolve({ data: null }),
    ]);

  if (!category) {
    notFound();
  }
  const grade = gradeRes.data;

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
        gradeId: (box.gradeId as string | null) ?? null,
        points: (box.points as number | null) ?? null,
      };
    });
  }

  const paths = (problems ?? []).map((p) => p.image_path);

  /** 주어진 경로들을 서명해 map 으로. 실패하면 빈 map 이다. */
  async function sign(list: string[]): Promise<Map<string, string>> {
    // **같은 주소로 다시 준다**(`signedUrls.ts`). 부를 때마다 새 주소를 만들면
    // 브라우저 이미지 캐시가 한 번도 안 걸려, 들어올 때마다 그림을 통째로
    // 다시 받는다 — Supabase egress 의 대부분이 여기서 나가고 있었다.
    return signCached(supabase, "problem-images", list);
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
        gradeId: p.gradeId ?? null,
        points: typeof p.points === "number" ? p.points : null,
        korean: readKoreanMeta(p.korean),
      };
    })
    .filter((p): p is GalleryProblem => p !== null);

  // `?gradeId=` 로 들어왔으면 그 채점 하나에 집중하고(채점 화면에서 "틀린문제
  // 오답 업로드하기"로 넘어온 흐름), 아니면 연결된 채점을 전부 보여준다.
  // 탐구는 1선택·2선택이 각각 독립된 행이라 한 실모에 둘이 붙을 수 있다.
  const uploaderGrades = grade ? [grade] : (linkedGrades ?? []);
  const uploadedCountByGrade = new Map<string, number>();
  for (const p of galleryProblems) {
    if (!p.gradeId) continue;
    uploadedCountByGrade.set(p.gradeId, (uploadedCountByGrade.get(p.gradeId) ?? 0) + 1);
  }
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
            label={categoryLabel(
              category,
              // 만점은 연결된 채점의 과목에서 온다(탐구 50). 없으면 100.
              linkedGrades?.[0] ? examMaxScore(linkedGrades[0].subject) : 100,
            )}
            examDate={category.exam_date}
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

      {linkedGrades && linkedGrades.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs font-medium text-slate-500">
            연동된 채점 기록
          </p>
          <div className="flex flex-wrap gap-2">
            {linkedGrades.map((g) => (
              <Link
                key={g.id}
                href={`/grades/${g.id}`}
                className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
              >
                {g.exam_name || `${SUBJECT_LABEL[g.subject]}${g.elective_label ? ` · ${g.elective_label}` : ""}`}
                {g.score != null && <> · {g.score}점</>}
                {uploadedCountByGrade.get(g.id) ? (
                  <> · 오답 {uploadedCountByGrade.get(g.id)}개 연결</>
                ) : null}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* **번호를 하나 고르고 사진 한 장씩 올리던 흐름은 없앴다**(사용자
          결정). 번호를 한꺼번에 붙이는 길(ProblemNumberScanner)이 따로 있고
          문제를 넣는 길도 여럿이라, 넣는 것은 편한 길로 넣고 **연결만
          여기서 한꺼번에** 하면 된다. "내가 고른 답"은 번호만 맞으면 저절로
          이어지므로(내보내기가 실모+번호로도 찾는다) 여기서는 정답 붙이기만
          한다. */}
      {uploaderGrades.map((g) => (
        <GradeLinkPanel
          key={g.id}
          gradeId={g.id}
          title={
            g.exam_name ||
            `${SUBJECT_LABEL[g.subject]}${g.elective_label ? ` · ${g.elective_label}` : ""}`
          }
          wrongNumbers={g.wrong_numbers}
          items={g.items}
          problems={galleryProblems
            // 지문은 문제가 아니다 — 번호도 정답도 붙일 대상이 아니다.
            .filter((p) => p.korean?.role !== "passage")
            .map((p) => ({
              id: p.id,
              number: p.number ?? parseProblemNumber(p.text),
              hasAnswer: p.answer.trim() !== "",
            }))}
        />
      ))}

      {/* 오답을 추가하는 길. 채점과 무관하게 늘 열려 있다. */}
      <AddProblemFlow categoryId={category.id} canAdd={access.canRecognize} />

      {/* 번호가 없는 문제에 번호를 한꺼번에 붙인다. 번호가 없으면 목록·PDF
          에서 저장된 차례대로 1번부터 매겨져 실제 시험지와 어긋난다. */}
      <ProblemNumberScanner
        targets={galleryProblems
          // **지문은 문제가 아니다.** 번호가 없는 게 정상이라 인식에 보내면
          // 토큰만 쓰고 못 읽거나, 안내 줄("[1~3] 다음 글을 읽고…")에서
          // 엉뚱한 번호를 집어 온다.
          .filter((p) => p.korean?.role !== "passage")
          .filter((p) => (p.number ?? parseProblemNumber(p.text)) == null)
          .map((p) => ({ id: p.id, imageUrl: p.imageUrl, text: p.text }))}
      />

      {/* 답지 한 장으로 정답을 한꺼번에 붙인다. 문제가 있어야 붙일 데가
          있으므로 하나도 없으면 감춘다. */}
      {galleryProblems.length > 0 && (
        <AnswerKeyPanel
          categoryId={category.id}
          categoryName={category.source}
          // 번호는 손으로 정한 값이 우선이고, 없으면 본문 맨 앞에서 뽑는다
          // (내보내기 화면과 같은 규칙 — 여기만 다르면 붙는 문제가 달라진다).
          problems={galleryProblems
            // 지문에는 붙일 정답이 없다.
            .filter((p) => p.korean?.role !== "passage")
            .map((p) => ({
              id: p.id,
              number: p.number ?? parseProblemNumber(p.text),
            }))}
        />
      )}

      <ProblemGallery problems={galleryProblems} unlimited={access.unlimited} />
    </main>
  );
}
