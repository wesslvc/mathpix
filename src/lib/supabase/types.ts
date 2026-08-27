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
  subject: "korean" | "math" | "elective";
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
 * 출처 표기 문자열을 만든다.
 * 실모(is_exam)이고 점수가 있으면 "강모2회(96)"처럼 뒤에 점수를 붙인다.
 */
export function categoryLabel(
  category: Pick<Category, "source" | "is_exam" | "score">,
): string {
  if (category.is_exam && category.score != null) {
    return `${category.source}(${category.score}/100)`;
  }
  return category.source;
}
