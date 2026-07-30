export type Category = {
  id: string;
  user_id: string;
  source: string;
  title: string | null;
  is_exam: boolean;
  score: number | null;
  exam_date: string | null;
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
  /** 사용자가 직접 정한 조건 박스 범위. null이면 자동 감지에 맡긴다. */
  box_range: { start: number; end: number } | { none: true } | null;
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
