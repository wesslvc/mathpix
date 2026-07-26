/**
 * 인식된 텍스트 맨 앞의 문제 번호(예: "22." → 22)를 뽑는다.
 * 없으면 null을 반환한다.
 */
export function parseProblemNumber(text: string): number | null {
  const m = text.trim().match(/^(\d{1,3})\s*[.)]/);
  return m ? Number(m[1]) : null;
}
