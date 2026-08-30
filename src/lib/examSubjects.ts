/**
 * 채점에서 고르는 과목 이름들. **자유 입력을 받지 않는다** — 오타·표기
 * 차이(예: "생윤" vs "생활과 윤리")가 성적 추세에서 다른 과목으로 갈리는
 * 것을 막는다.
 */

import type { Subject } from "./gradeSummary";

/** 자동채점 화면과 프로필의 기본 과목 설정이 같은 이름을 써야 한다. */
export const SUBJECT_LABEL: Record<Subject, string> = {
  korean: "국어",
  math: "수학",
  english: "영어",
  elective: "탐구",
};

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

/**
 * 자동채점 초기 버전은 탐구 과목명을 자유 입력으로 받았다(17과목 select는
 * 나중에 붙였다) — 그때 저장된 옛 기록에는 "지구과학1"처럼 로마 숫자
 * (Ⅰ·Ⅱ) 대신 아라비아 숫자로 적힌 과목명이 남아 있을 수 있다. 성적
 * 추세·목록 묶기(과목별 보기)가 과목명을 그대로 키로 쓰기 때문에, 표기가
 * 다르면 같은 과목인데 다른 범주로 갈린다 — "지구과학1"과 "지구과학Ⅰ"이
 * 서로 다른 그래프 선·그룹으로 보이는 식이다.
 *
 * 옛 데이터를 고쳐 쓰는 대신(마이그레이션 필요) 묶는 시점에 정규화한다 —
 * 끝자리 1·2를 로마 숫자로 바꿔봐서 17과목 목록에 있으면 그걸 쓰고,
 * 없으면(사회탐구처럼 원래 숫자가 없는 과목) 원래 값 그대로 둔다.
 */
export function normalizeElectiveLabel(label: string): string {
  const trimmed = label.trim();
  const m = trimmed.match(/^(.+?)([12])$/);
  if (!m) return trimmed;
  const candidate = `${m[1]}${m[2] === "1" ? "Ⅰ" : "Ⅱ"}`;
  return ELECTIVE_SUBJECTS.includes(candidate) ? candidate : trimmed;
}

/** 수학 선택과목(공통 22문항 + 이 중 택1의 8문항). */
export const MATH_ELECTIVES = ["미적분", "확률과 통계", "기하"] as const;

/** 국어 선택과목(공통 34문항 + 이 중 택1의 11문항). */
export const KOREAN_ELECTIVES = ["언어와 매체", "화법과 작문"] as const;
