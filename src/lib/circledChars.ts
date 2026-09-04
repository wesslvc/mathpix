/**
 * 원문자(㉠ ① ⓐ)를 다루는 표 하나.
 *
 * **네트워크 호출도 환경변수도 없다** — `problemBoxes.ts`·`gradeSummary.ts`·
 * `koreanSet.ts` 와 같은 이유다. 그림 프롬프트(`figureImageGen.ts`)와 지문
 * 조판 프롬프트(`gradeExam.ts`)가 **같은 표**를 봐야 하는데, 양쪽에 따로
 * 적어 두면 반드시 한쪽만 고쳐진다(자모 표를 `renderMathText.ts` 에서
 * export 해 재사용한 것과 같은 판단이다).
 */

/**
 * 원문자를 "안에 든 글자"로 풀어 준다. 모르는 글자면 null.
 *
 * 유니코드가 원문자를 **한 코드포인트**로 갖고 있어서 모델은 이걸 통글자로
 * 다루는데, 그러다 안쪽 글자가 바뀐다. 표를 직접 들고 있는 이유는
 * `String.normalize("NFKD")` 로는 원이 사라진 글자만 남을 뿐 "동그라미 안에
 * 무엇" 이라는 정보가 되지 않기 때문이다 — 우리는 그 문장을 만들어야 한다.
 */
export function insideCircle(ch: string): string | null {
  const c = ch.codePointAt(0);
  if (c === undefined) return null;
  // ㉠~㉭ (동그라미 안 자음). ㄱ~ㅎ 구간(U+3131~)이 쌍자음·겹받침 때문에
  // 이어져 있지 않아서 표를 그대로 적는다.
  if (c >= 0x3260 && c <= 0x326d)
    return "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"[c - 0x3260];
  // ㉮~㉻ (동그라미 안 가나다)
  if (c >= 0x326e && c <= 0x327b)
    return "가나다라마바사아자차카타파하"[c - 0x326e];
  // ①~⑳
  if (c >= 0x2460 && c <= 0x2473) return String(c - 0x2460 + 1);
  // Ⓐ~Ⓩ / ⓐ~ⓩ
  if (c >= 0x24b6 && c <= 0x24cf)
    return String.fromCodePoint(0x41 + c - 0x24b6);
  if (c >= 0x24d0 && c <= 0x24e9)
    return String.fromCodePoint(0x61 + c - 0x24d0);
  return null;
}

/**
 * 글에 실제로 나온 원문자만 골라 **원문자 차례로** 늘어놓는다.
 *
 * 나온 차례가 아닌 이유: 본문이 `㉠~㉢` 처럼 범위로 먼저 나오면 나온 차례는
 * ㉠ ㉢ ㉡ 이 되는데, 바로 아래에서 "순서를 뒤바꾸지 말라"고 해 놓고 우리가
 * 뒤바꾼 목록을 주는 꼴이 된다.
 */
export function circledCharsIn(text: string): string[] {
  const seen: string[] = [];
  for (const ch of text) {
    if (insideCircle(ch) !== null && !seen.includes(ch)) seen.push(ch);
  }
  seen.sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
  return seen;
}

/** `㉠(circle around ㄱ), ㉡(circle around ㄴ)` 꼴로 적는다. */
export function circledPairs(chars: string[]): string {
  return chars.map((ch) => `${ch}(circle around ${insideCircle(ch)})`).join(", ");
}
