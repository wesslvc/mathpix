import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { categoryLabel, type Category, type ExamScore } from "@/lib/supabase/types";
import { parseProblemNumber, readProblemNumber } from "@/lib/problemNumber";
import { formatAnswer, toAnswerType } from "@/lib/answer";
import { readKoreanMeta } from "@/lib/koreanSet";
import ExportComposer, {
  type ComposerProblem,
} from "@/components/ExportComposer";

/**
 * 내보내기에 **실제로 쓰는 것만** 가져온다.
 *
 * 예전에는 `select("*")` 였는데, 그러면 `box_range` 가 통째로 딸려온다. 거기엔
 * 그림이 base64 로 들어 있어서 **행 하나가 평균 1.1MB, 큰 것은 4MB** 다 —
 * 20문제짜리 실모를 고르면 화면 한 번 여는 데 **20MB 넘는 JSON** 을 내려받는다.
 * 그런데 여기서 쓰는 것은 `debt`(잠금)와 `number`(손으로 적은 번호) 둘뿐이다.
 *
 * 목록 화면(`categories/[id]`)이 같은 이유로 이미 이렇게 뽑고 있다. 이쪽만
 * 빠져 있었고, 배치 설정을 만지느라 여러 번 여는 화면이라 더 나빴다.
 * JSON 경로 선택이 막힌 환경이면 목록이 통째로 안 나오는 것보다 나으므로
 * `select("*")` 로 되돌아간다(그쪽과 같은 방식).
 */
const EXPORT_COLUMNS = [
  "id",
  "category_id",
  "image_path",
  "latex",
  "text_content",
  "answer",
  "answer_type",
  "sort_order",
  "created_at",
  "problemNo:box_range->number",
  "debt:box_range->debt",
  // 어느 채점 기록에서 온 문제인지 — 정답표에 "내가 고른 답"을 같이 찍는 데 쓴다.
  "gradeId:box_range->>gradeId",
  // 국어 지문·문제 묶음. 그림이 든 box_range 를 통째로 받지 않으려고 이 키만 뽑는다.
  "korean:box_range->korean",
].join(", ");

type ExportRow = {
  id: string;
  category_id: string;
  image_path: string;
  latex: string | null;
  text_content: string | null;
  answer: string | null;
  answer_type: string | null;
  sort_order: number | null;
  created_at: string;
  problemNo: number | null;
  debt: number | null;
  gradeId: string | null;
  korean: unknown;
};

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  const idList = (ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Supabase 설정이 아직 완료되지 않았습니다.
        </p>
      </main>
    );
  }

  if (idList.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-10">
        <p className="text-sm text-slate-500">
          출력할 실모를 선택하지 않았습니다.{" "}
          <Link href="/" className="text-blue-600 underline">
            목록으로 돌아가기
          </Link>
        </p>
      </main>
    );
  }

  const supabase = await createClient();

  const { data: categories } = await supabase
    .from("categories")
    .select("*")
    .in("id", idList)
    .returns<Category[]>();

  const categoryById = new Map((categories ?? []).map((c) => [c.id, c]));

  const slim = await supabase
    .from("problems")
    .select(EXPORT_COLUMNS)
    .in("category_id", idList)
    .returns<ExportRow[]>();

  let problems = slim.data;
  if (slim.error) {
    const full = await supabase
      .from("problems")
      .select("*")
      .in("category_id", idList);
    problems = (full.data ?? []).map((p) => {
      const box = (p.box_range ?? {}) as Record<string, unknown>;
      return {
        ...(p as unknown as ExportRow),
        problemNo: (box.number as number | null) ?? null,
        debt: (box.debt as number | null) ?? null,
      };
    });
  }

  /**
   * 미납으로 잠긴 문제는 뺀다.
   *
   * **여기서 안 빼면 잠금이 겉모양뿐이다** — 목록에서만 가려 놓고 인쇄물에는
   * 그대로 나오면 막은 게 아니다. 몇 개가 빠졌는지는 아래에서 알려 준다
   * (조용히 사라지면 문제가 없어진 줄 안다).
   */
  const isLocked = (p: ExportRow) => typeof p.debt === "number" && p.debt > 0;
  const lockedCount = (problems ?? []).filter(isLocked).length;

  // 선택한 실모 순서대로, 각 실모 안에서는 sort_order 순으로 정렬.
  const ordered = (problems ?? [])
    .filter((p) => !isLocked(p))
    .slice()
    .sort((a, b) => {
      const ai = idList.indexOf(a.category_id);
      const bi = idList.indexOf(b.category_id);
      if (ai !== bi) return ai - bi;
      const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.created_at.localeCompare(b.created_at);
    });

  // 채점 기록이 연동된 문제는 **내가 무엇을 골라서 틀렸는지**도 정답표에
  // 같이 찍는다. 학생답은 exam_scores.items 에 문항 번호별로 들어 있다.
  const { data: gradeRows } = await supabase
    .from("exam_scores")
    .select("id, category_id, items")
    .in("category_id", idList)
    .returns<Pick<ExamScore, "id" | "category_id" | "items">[]>();

  // 문제 → 학생답을 찾는 표. 채점 기록 id 로 맞추는 게 정확하지만(한 실모에
  // 여러 번 채점했을 수 있다), 옛 문제에는 gradeId 가 없으므로 실모+번호로도
  // 찾을 수 있게 둘 다 만들어 둔다.
  const studentByGradeNo = new Map<string, string>();
  const studentByCategoryNo = new Map<string, string>();
  for (const g of gradeRows ?? []) {
    for (const item of g.items ?? []) {
      const picked = (item.studentAnswer ?? "").trim();
      if (!picked) continue;
      studentByGradeNo.set(`${g.id}:${item.no}`, picked);
      // 같은 번호가 여러 채점에 있으면 먼저 만난 것을 둔다(더 알 방법이 없다).
      const catKey = `${g.category_id}:${item.no}`;
      if (!studentByCategoryNo.has(catKey)) studentByCategoryNo.set(catKey, picked);
    }
  }

  const paths = ordered.map((p) => p.image_path);
  const signedUrlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("problem-images")
      .createSignedUrls(paths, 60 * 60);
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) signedUrlByPath.set(s.path, s.signedUrl);
    }
  }

  const composerProblems: ComposerProblem[] = ordered
    .map((p): ComposerProblem | null => {
      const imageUrl = signedUrlByPath.get(p.image_path);
      if (!imageUrl) return null;
      const cat = categoryById.get(p.category_id);
      return {
        id: p.id,
        imageUrl,
        source: cat ? categoryLabel(cat) : "출처",
        // 점수를 뺀 출처. 같은 출처가 여러 페이지에 걸칠 때 점수를 반복하지 않는다.
        sourceBase: cat?.source ?? "출처",
        origNumber: parseProblemNumber(p.text_content || p.latex || ""),
        // 손으로 정해 둔 번호가 있으면 그게 우선이다(통째로 그린 문제는 본문이
        // 없어서 뽑을 것도 없다).
        manualNumber: readProblemNumber({ number: p.problemNo }),
        // 국어 지문·문제 묶음(국어 모드로 넣은 것에만 있다).
        korean: readKoreanMeta(p.korean),
        // 객관식이면 "1" -> "①"로 바꿔 정답표에 찍는다. 저장은 원문 그대로이고
        // 변환은 표시할 때만 한다(유형을 바꾸면 되돌아가야 하므로).
        answer: formatAnswer(p.answer, toAnswerType(p.answer_type)),
        // 내가 고른 답(틀린 문제면 이게 곧 "왜 틀렸는지"다). 정답과 같은
        // 방식으로 원숫자로 바꿔 찍는다.
        studentAnswer: (() => {
          const no = readProblemNumber({ number: p.problemNo }) ??
            parseProblemNumber(p.text_content || p.latex || "");
          if (no == null) return undefined;
          const picked =
            (p.gradeId ? studentByGradeNo.get(`${p.gradeId}:${no}`) : undefined) ??
            studentByCategoryNo.get(`${p.category_id}:${no}`);
          return picked
            ? formatAnswer(picked, toAnswerType(p.answer_type))
            : undefined;
        })(),
      };
    })
    .filter((p): p is ComposerProblem => p !== null);

  const multi = idList.length > 1;
  const firstCategory = categories?.find((c) => c.id === idList[0]);
  const defaultTitle =
    !multi && firstCategory ? categoryLabel(firstCategory) : "";

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // 단일 선택이면 그 실모의 시행일, 복수 선택이면 오늘(모음 만드는 날)로.
  const examDate =
    !multi && firstCategory?.exam_date ? firstCategory.exam_date : todayIso;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <header>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gblue hover:underline"
        >
          ← 목록으로
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-ink">PDF 만들기</h1>
        <p className="text-sm text-slate-500">
          실모 {idList.length}개 · 문제 {composerProblems.length}개
        </p>
        {/* 조용히 빠지면 문제가 없어진 줄 안다. 왜 빠졌는지 밝힌다. */}
        {lockedCount > 0 && (
          <p className="mt-1 text-sm text-amber-700">
            토큰이 모자라 잠긴 문제 {lockedCount}개는 빠졌습니다. 실모 화면에서
            잠금을 해제하면 함께 인쇄돼요.
          </p>
        )}
      </header>

      {composerProblems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
          선택한 실모에 저장된 오답이 없습니다.
        </p>
      ) : (
        <ExportComposer
          multi={multi}
          defaultTitle={defaultTitle}
          examDate={examDate}
          problems={composerProblems}
        />
      )}
    </main>
  );
}
