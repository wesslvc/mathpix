/**
 * 문제 원문(mmd)을 "글자"와 "수식"으로 쪼갠다.
 *
 * 사람들이 LaTeX를 직접 고치는 걸 어색해해서, 화면에 보이는 글씨를 그대로
 * 고치면 원문이 알아서 따라오게 만들려고 쓰는 조각들이다. 글자 부분은 마음껏
 * 고치게 두고, 수식은 통째로 하나의 덩어리로 다뤄 실수로 반쪽만 지워지는 일이
 * 없게 한다.
 *
 * AI는 쓰지 않는다 — 순수하게 문자열을 쪼갰다 다시 합치는 것뿐이라 원문이
 * 그대로 보존된다.
 */
export type MathToken =
  | { kind: "text"; value: string }
  | { kind: "math"; latex: string; display: boolean };

/** "$$...$$"가 먼저다 — "$...$"를 먼저 보면 "$$"의 반쪽만 잡힌다. */
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

export function tokenizeMath(input: string): MathToken[] {
  const out: MathToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  MATH_PATTERN.lastIndex = 0;
  while ((m = MATH_PATTERN.exec(input)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", value: input.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      out.push({ kind: "math", latex: m[1].trim(), display: true });
    } else {
      out.push({ kind: "math", latex: (m[2] ?? "").trim(), display: false });
    }
    last = MATH_PATTERN.lastIndex;
  }
  if (last < input.length) {
    out.push({ kind: "text", value: input.slice(last) });
  }
  return out;
}

/** 쪼갠 조각을 다시 원문으로. tokenize → join은 항상 원문과 같아야 한다. */
export function joinMathTokens(tokens: MathToken[]): string {
  return tokens
    .map((t) =>
      t.kind === "text"
        ? t.value
        : t.display
          ? `$$${t.latex}$$`
          : `$${t.latex}$`,
    )
    .join("");
}
