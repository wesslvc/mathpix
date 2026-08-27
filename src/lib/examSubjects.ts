/**
 * 채점에서 고르는 과목 이름들. **자유 입력을 받지 않는다** — 오타·표기
 * 차이(예: "생윤" vs "생활과 윤리")가 성적 추세에서 다른 과목으로 갈리는
 * 것을 막는다.
 */

/** 사회탐구 9 + 과학탐구 8 = 17. 수능 탐구영역 과목 전체. */
export const SOCIAL_ELECTIVES = [
  "생활과 윤리",
  "윤리와 사상",
  "한국지리",
  "세계지리",
  "동아시아사",
  "세계사",
  "경제",
  "정치와 법",
  "사회·문화",
] as const;

export const SCIENCE_ELECTIVES = [
  "물리학Ⅰ",
  "물리학Ⅱ",
  "화학Ⅰ",
  "화학Ⅱ",
  "생명과학Ⅰ",
  "생명과학Ⅱ",
  "지구과학Ⅰ",
  "지구과학Ⅱ",
] as const;

export const ELECTIVE_SUBJECTS: readonly string[] = [
  ...SOCIAL_ELECTIVES,
  ...SCIENCE_ELECTIVES,
];

/** 수학 선택과목(공통 22문항 + 이 중 택1의 8문항). */
export const MATH_ELECTIVES = ["미적분", "확률과 통계", "기하"] as const;

/** 국어 선택과목(공통 34문항 + 이 중 택1의 11문항). */
export const KOREAN_ELECTIVES = ["언어와 매체", "화법과 작문"] as const;
