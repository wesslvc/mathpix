/**
 * 인식된 텍스트 맨 앞의 문제 번호(예: "22." → 22)를 뽑는다.
 * 없으면 null을 반환한다.
 */
export function parseProblemNumber(text: string): number | null {
  const m = text.trim().match(/^(\d{1,3})\s*[.)]/);
  return m ? Number(m[1]) : null;
}

/**
 * 사용자가 손으로 정해 둔 문제 번호를 읽는다.
 *
 * **저장 위치가 `problems.box_range`인 이유**는 글자 크기(`fontPt`)·그림
 * (`figures`)과 같다 — 새 컬럼을 만들면 마이그레이션을 안 돌린 사람에게는
 * 저장 자체가 실패한다. 이미 있는 jsonb 에 키를 얹으면 그 위험이 없다.
 *
 * 이 값이 있으면 **본문에서 뽑은 번호보다 우선한다.** 손으로 적은 것이
 * 자동 인식보다 확실하기 때문이다(통째로 그린 문제는 본문이 아예 없다).
 */
export function readProblemNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  const n = (value as { number?: unknown }).number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
