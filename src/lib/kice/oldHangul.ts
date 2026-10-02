/**
 * **옛한글(중세 국어)을 평가원 PDF 에 그리기 위한 글자 다루기**(순수 — 네트워크도 글꼴도 없다).
 *
 * 옛한글 음절은 조합용 자모를 이어 써서(초성 U+1100~ + 중성 U+1160~ + 종성 U+11A8~) 한 글자로
 * **조립**된다(ᄃᆞᆰ = U+1103 U+119E U+11B0). pdf-lib 의 `drawText` 는 글자 모양 조립(shaping)을 안 해서
 * 자모가 낱낱이 흩어지거나, 본문 글꼴(신중명조)에 없는 글자라 통째로 지워진다. 그래서 이 구간만
 * 떼어 fontkit 으로 조립한 글리프를 **선(path)으로** 그린다(`pdf.ts`).
 *
 * 여기서는 두 가지만 한다:
 *   - `oldHangulRuns` — 글을 "보통 글"과 "옛한글 구간"으로 가른다.
 *   - `textClusters` — 줄바꿈이 음절 한가운데를 자르지 않게 글자를 음절 단위로 묶는다.
 */

const L = "\\u1100-\\u115F\\uA960-\\uA97C";
const V = "\\u1160-\\u11A7\\uD7B0-\\uD7C6";
const T = "\\u11A8-\\u11FF\\uD7CB-\\uD7FB";
const TONE = "\\u302E\\u302F";
const SYLLABLE = "\\uAC00-\\uD7A3";
const JAMO = "\\u1100-\\u11FF\\uA960-\\uA97F\\uD7B0-\\uD7FF";

/**
 * 옛한글 구간. 앞에 붙은 완성형 음절도 함께 잡는다 — 현대 음절 뒤에 옛 종성(가ᇫ)이나 방점(나〮)이
 * 붙으면 그 둘이 한 글자로 조립돼야 하기 때문이다(fontkit 이 완성형을 자모로 풀어 다시 조립한다).
 */
const RUN_RE = new RegExp(`(?:[${SYLLABLE}](?=[${T}${TONE}]))?[${JAMO}${TONE}]+`, "gu");

export const OLD_HANGUL_TEST = new RegExp(`[${JAMO}${TONE}]`, "u");

export function hasOldHangul(text: string): boolean {
  return OLD_HANGUL_TEST.test(text);
}

export type TextRun = { t: string; old: boolean };

export function oldHangulRuns(text: string): TextRun[] {
  const out: TextRun[] = [];
  let last = 0;
  for (const m of text.matchAll(RUN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: text.slice(last, at), old: false });
    out.push({ t: m[0], old: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), old: false });
  return out;
}

/** 한 음절(완성형 + 옛 종성·방점 / 초성+중성+종성 / 남은 자모 묶음) 또는 글자 하나. */
const CLUSTER_RE = new RegExp(
  `[${SYLLABLE}][${T}]*[${TONE}]?|[${L}]+[${V}]*[${T}]*[${TONE}]?|[${V}${T}]+[${TONE}]?|[\\s\\S]`,
  "gu",
);

/** 줄바꿈 단위. 옛한글이 없으면 `[...text]` 와 같다. */
export function textClusters(text: string): string[] {
  if (!hasOldHangul(text)) return [...text];
  return text.match(CLUSTER_RE) ?? [];
}
