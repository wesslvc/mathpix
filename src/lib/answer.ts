/** 정답 유형. 객관식이면 숫자를 원숫자(①②③)로 바꿔 표기한다. */
export type AnswerType = "choice" | "short";

export const ANSWER_TYPE_LABEL: Record<AnswerType, string> = {
  choice: "객관식",
  short: "주관식",
};

// ①~⑮. 전부 BMP 문자라 인덱싱으로 꺼내도 안전하다.
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮";

/** 1~15를 원숫자로. 범위를 벗어나면 null. */
export function toCircledNumber(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > CIRCLED.length) return null;
  return CIRCLED[n - 1];
}

/**
 * 정답표에 찍을 문자열을 만든다.
 *
 * 객관식이면 사용자가 "1"이라고 적어도 "①"로 바꿔 보여준다(문제집 표기와
 * 맞추기 위해). 이미 원숫자로 적었으면 그대로 두고, 15를 넘는 숫자처럼
 * 원숫자가 없는 경우도 원문을 유지한다.
 *
 * 저장은 항상 사용자가 입력한 원문 그대로 하고 변환은 표시할 때만 한다 —
 * 변환된 값을 저장해버리면 나중에 수정 화면에서 "①"이 떠서 고치기 불편하고,
 * 유형을 주관식으로 바꿨을 때 되돌릴 수가 없다.
 */
export function formatAnswer(
  answer: string | null | undefined,
  type: AnswerType | null | undefined,
): string {
  const raw = (answer ?? "").trim();
  if (!raw || type !== "choice") return raw;
  return raw.replace(/\d+/g, (digits) => toCircledNumber(Number(digits)) ?? digits);
}

/** DB에 들어있는 값(자유 문자열)을 안전하게 AnswerType으로 좁힌다. */
export function toAnswerType(value: unknown): AnswerType {
  return value === "choice" ? "choice" : "short";
}
