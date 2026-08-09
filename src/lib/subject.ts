/**
 * 과목 모드.
 *
 * 텍스트와 수식을 Mathpix로 읽는 부분은 두 모드가 완전히 같다. 갈라지는 건
 * "그림을 어떻게 처리하느냐" 하나뿐이다:
 *   math    — 수학 도형을 Gemini가 벡터로 다시 그린다(도형 추가인식)
 *   science — 사과탐 자료를 OpenAI가 다시 그리거나, 원본을 그대로 붙인다
 *
 * 두 도구를 한 화면에 같이 두면 어느 걸 눌러야 하는지 헷갈리고, 잘못 눌러
 * 엉뚱한 모델에 크레딧을 쓰게 된다. 그래서 모드에 맞는 것만 보여준다.
 */
export type Subject = "math" | "science";

export const SUBJECT_LABEL: Record<Subject, string> = {
  math: "수학",
  science: "사회·과학탐구",
};

export const SUBJECT_HINT: Record<Subject, string> = {
  math: "도형은 Gemini가 벡터로 다시 그립니다.",
  science: "자료는 원본을 그대로 붙이거나 GPT가 다시 그립니다.",
};

export function isSubject(value: unknown): value is Subject {
  return value === "math" || value === "science";
}

/**
 * 실모(카테고리)별로 마지막에 고른 모드를 기억한다.
 *
 * DB가 아니라 브라우저에 두는 이유: 이 값은 인쇄물이나 저장 데이터에 전혀
 * 영향을 주지 않고 오직 "작업 화면에 어떤 버튼을 보여줄까"만 정한다. 이걸
 * 위해 마이그레이션을 하나 더 만들어 사용자가 SQL을 돌리게 할 이유가 없다.
 * (서버에 두고 싶어지면 categories에 subject 컬럼 하나 추가하면 된다.)
 */
const KEY_PREFIX = "reprintocr.subject.";

export function loadSubject(categoryId: string): Subject {
  if (typeof window === "undefined") return "math";
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + categoryId);
    return isSubject(raw) ? raw : "math";
  } catch {
    return "math";
  }
}

export function saveSubject(categoryId: string, subject: Subject): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_PREFIX + categoryId, subject);
  } catch {
    // 저장소를 못 쓰는 환경이면 이번 세션 동안만 유지된다(기능에는 지장 없음).
  }
}
