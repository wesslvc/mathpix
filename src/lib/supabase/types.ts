export type Category = {
  id: string;
  user_id: string;
  source: string;
  title: string | null;
  is_exam: boolean;
  score: number | null;
  exam_date: string | null;
  created_at: string;
  /** 어느 폴더에 속하는지. null이면 "폴더 없음". */
  folder_id: string | null;
};

/** 실모를 담아 정리하는 폴더(단순 1단계 — 폴더 안에 폴더는 없다). */
export type Folder = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
};

/** 채점한 문항 하나(세부오답 보기·정답 자동 채우기에 쓴다). */
export type GradedItemRow = {
  no: number;
  studentAnswer: string | null;
  correctAnswer: string;
  points?: number;
};

/** 자동채점 결과 한 건(탐구는 1선택/2선택이 각각 독립된 행이다). */
export type ExamScore = {
  id: string;
  user_id: string;
  category_id: string | null;
  subject: "korean" | "math" | "english" | "elective";
  /**
   * 탐구는 1선택/2선택 과목명(17과목 중 하나), 수학은 선택과목(미적분·
   * 확률과 통계·기하), 국어는 선택과목(언어와 매체·화법과 작문).
   */
  elective_slot: 1 | 2 | null;
  elective_label: string | null;
  /** 사용자가 적은 시험 이름(예: "2025학년도 9월 모의평가"). */
  exam_name: string | null;
  total_questions: number;
  correct_count: number;
  wrong_numbers: number[];
  score: number | null;
  /** 1~9. 등급컷은 해마다 달라 자동 계산하지 않고 사용자가 직접 적는다. */
  grade_level: number | null;
  /** 문항별 상세. 옛 기록에는 없을 수 있다(그 전에는 요약만 저장했다). */
  items: GradedItemRow[] | null;
  /**
   * 시험지 전체에 대한 메모. **국어에서만 쓴다** — 국어는 지문이 여러
   * 문항에 걸쳐 있어 "문제 하나 사진"이라는 오답추가 단위와 안 맞아서,
   * 문항별 오답 대신 시험 전체 코멘트를 남기게 했다.
   */
  comment: string | null;
  taken_at: string;
  created_at: string;
};

export type Problem = {
  id: string;
  category_id: string;
  user_id: string;
  image_path: string;
  latex: string | null;
  text_content: string | null;
  answer: string | null;
  /** 'choice'(객관식) | 'short'(주관식). 객관식이면 정답표에 원숫자로 표기한다. */
  answer_type: string | null;
  /**
   * 사용자가 직접 정한 조건 박스 범위. null이면 자동 감지에 맡긴다.
   * 지금 저장되는 형태는 `{ ranges: [...] }`(빈 배열 = 박스 없음)이고,
   * 나머지 둘은 박스를 하나만 만들 수 있던 시절의 옛 값이라 읽기만 한다.
   * 형태 구분은 renderMathText의 toBoxRanges()가 전부 흡수한다.
   */
  box_range:
    | { ranges: { start: number; end: number }[] }
    | { start: number; end: number }
    | { none: true }
    | null;
  sort_order: number | null;
  created_at: string;
};

/**
 * 출처 표기 문자열. **적어 둔 제목 그대로다.**
 *
 * 예전에는 실모(is_exam)이고 점수가 있으면 "강모2회(96/100)"처럼 뒤에 점수를
 * 붙였다. 사용자가 그만두라고 했다("이제 제목에 괄호치고 점수넣지마") —
 * 제목은 시험을 가리키는 이름이고 점수는 그 시험을 본 결과라, 둘을 한 글자로
 * 묶으면 PDF 제목·문제 출처 표기·정답표 머리글에 점수가 따라다닌다.
 *
 * **점수를 화면에서 없애는 것이 아니다.** 목록과 실모 화면에서는
 * `categoryScore()` 로 뽑아 **제목 옆에 따로** 보여 준다.
 */
export function categoryLabel(
  category: Pick<Category, "source" | "is_exam" | "score">,
): string {
  return category.source;
}

/**
 * 제목 옆에 따로 붙일 점수("96/100"). 실모가 아니거나 점수가 없으면 null.
 *
 * **만점을 100으로 못박으면 안 된다** — 탐구는 원점수 만점이 50점이라
 * "36/100"처럼 절반짜리로 보인다(사용자 신고). categories 자체에는 과목이
 * 없으므로, 연결된 채점 기록(exam_scores.subject)에서 구한 만점을 넘겨
 * 준다(`examMaxScore`). 연결된 채점이 없으면 알 길이 없으니 100으로 둔다.
 */
export function categoryScore(
  category: Pick<Category, "is_exam" | "score">,
  maxScore = 100,
): string | null {
  if (!category.is_exam || category.score == null) return null;
  return `${category.score}/${maxScore}`;
}
