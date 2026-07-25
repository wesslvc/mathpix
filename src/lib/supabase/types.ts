export type Category = {
  id: string;
  user_id: string;
  source: string;
  title: string | null;
  is_exam: boolean;
  score: number | null;
  created_at: string;
};

export type Problem = {
  id: string;
  category_id: string;
  user_id: string;
  image_path: string;
  latex: string | null;
  text_content: string | null;
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
    return `${category.source}(${category.score})`;
  }
  return category.source;
}
