import { circledFamily, insideCircle } from "../circledChars";
import { applyMarks, emptyMarkStats, type MarkStats, type RichBlock } from "./richText";

/**
 * **서식 검수 — 두 번째 호출**(2026-09-25, 사용자 요청 — "텍스트 인식 능력은
 * 문제 풀이에 충분한데 원문자·밑줄·작은 박스·볼드 처리가 너무 아쉬워, 보강 좀").
 *
 * 한 번의 호출(`KOREAN_TEXT_PROMPT`)이 글자와 서식을 함께 읽으면 모델은 **글자를
 * 옮기는 데 힘을 다 쓰고** 서식은 대충 짚는다. 게다가 지문 사진은 세로로 길어서
 * 비전 모델이 짧은 변을 768px 로 줄여 보므로(`detail:high`) 가는 밑줄과 동그라미
 * 안의 획이 뭉개진다. 그래서 글자를 다 읽은 **뒤에** 따로 한 번 더 묻는다:
 *
 * - 할 일은 **서식과 원문자뿐**이다. 글은 이미 있으니(문단마다 p1…pN) 모델은
 *   그 글에서 어디가 굵게·밑줄·네모인지, 원문자가 정확히 무엇인지만 본다.
 * - 사진은 **전체 한 장 + 가로 띠 여러 장**을 보낸다. 띠는 폭이 원본 그대로라
 *   축소가 거의 없다 — 확대해서 보는 셈이다(띠는 브라우저가 자른다, `passageStrips`).
 * - 결과는 **코드가** 붙인다(`applyMarksReview`): 원문자는 계열마다 개수가 맞을
 *   때만 차례로 갈아 끼우고, 서식은 그 문단을 통째로 새 표시로 바꾼다.
 *
 * 이 파일에는 네트워크 호출도 환경변수도 없다 — 서버(프롬프트·해석)와 화면
 * (적용)이 같은 규칙을 써야 한다(`problemBoxes.ts` 와 같은 이유).
 */

/** 검수에 보낼 문단 글(상자 안까지 읽는 차례대로). */
export function reviewParagraphs(blocks: RichBlock[]): string[] {
  const out: string[] = [];
  const walk = (list: RichBlock[]) => {
    for (const b of list) {
      if (b.kind === "para") out.push(b.runs.map((r) => r.t).join(""));
      else if (b.kind === "box") walk(b.blocks);
    }
  };
  walk(blocks);
  return out;
}

const MARKS_REVIEW_PROMPT = `task: proofread the PRINTED MARKS of a Korean SAT (수능) 국어 passage. the text was already transcribed correctly (listed at the end, one line per paragraph: p1, p2, …). do NOT retype or fix the text. your ONLY job: find every bold span, every printed underline, every small printed box, and identify every circled character — exactly, character by character.

images: the FIRST image is the whole passage. the following images are ZOOMED horizontal strips of the same passage, top to bottom, overlapping slightly. read thin rules, stroke weight and small glyphs in the strips.

answer JSON only:
{"paras":[{"p":1,"circled":["㉠","㉡"],"marks":[{"type":"u","text":"exact span","nth":1}]}]}
- list EVERY paragraph p1…pN in order, even when it has nothing: {"p":3,"circled":[],"marks":[]}

circled — every circled character printed in that paragraph, in reading order, one entry per occurrence (a paragraph may repeat ㉠):
- identify each one by the glyph INSIDE its circle, looking at it in the zoomed strip: ㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭ = ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ · ㉮㉯㉰㉱㉲㉳ = 가나다라마바 · ①②③④⑤⑥ = 1-6 · ⓐⓑⓒⓓⓔ = a-e · Ⓐ Ⓑ Ⓒ = A-C
- never infer from alphabetical order or from neighbours — a passage may use only ㉡ and ㉣. never switch families (㉠ vs ⓐ vs ①). the transcription may have one wrong or missing: your list is what counts
- a range like "㉠~㉢" = two entries ㉠, ㉢

marks — printed styling only:
- text = the EXACT characters the mark covers, copied from that paragraph's line (write circled characters as you identified them). start at the first marked character, stop at the last one. nothing more, nothing less
- "u" printed underline = a thin, straight, crisp rule of the same dark ink as the print, sitting right under the characters. follow it and note exactly where it starts and stops: it usually covers a phrase, not the whole line. an underline beginning right after a circled marker (㉠ 표현, ⓐ 부분) is ALWAYS printed — the question asks about "밑줄 친 ㉠"; the circled char itself is outside the underline unless the rule clearly runs under it. an underline running over a line break = ONE mark covering the whole phrase
- "sq" = a small printed rectangle drawn tightly around a word or phrase (a boxed expression pointed at by a question, e.g. 「 」 is not a box). not a bordered frame around whole paragraphs
- "b" = bold: strokes clearly heavier than the surrounding print (key terms, headings, [A]-style labels). compare stroke weight with the neighbouring characters in the strip; ordinary text is not bold
- handwritten marks are NOT marks: faint, wobbly, pencil/pen lines, uneven width, overshooting the words, a different colour, hand-drawn circles/boxes/ticks/notes → ignore completely
- two styles on the same span (bold + underline) → two marks with the same text
- nth = which occurrence in that paragraph's line when the same characters appear more than once (1 = first). omit when once
- nothing marked → "marks":[]
- JSON only, no explanation

paragraphs:
`;

/** 검수 프롬프트(문단 글까지 붙인 것). 줄바꿈은 띄어쓰기로 편다 — 짚는 쪽이 띄어쓰기 차이를 봐 준다. */
export function marksReviewPrompt(paragraphs: string[]): string {
  return (
    MARKS_REVIEW_PROMPT +
    paragraphs.map((t, i) => `p${i + 1}: ${t.replace(/\s*\n\s*/g, " ")}`).join("\n")
  );
}

export type MarksReviewPara = { p: number; circled: string[]; marks: unknown[] };

/** 모델 응답을 읽는다. 모양이 이상한 문단은 버린다(그 문단은 첫 번째 결과를 그대로 둔다). */
export function parseMarksReview(text: string): MarksReviewPara[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) return [];
    try {
      raw = JSON.parse(text.slice(a, b + 1));
    } catch {
      return [];
    }
  }
  const list = (raw as { paras?: unknown })?.paras;
  if (!Array.isArray(list)) return [];
  const out: MarksReviewPara[] = [];
  for (const row of list.slice(0, 400)) {
    const o = row as { p?: unknown; circled?: unknown; marks?: unknown };
    const p = Math.floor(Number(o?.p));
    if (!Number.isFinite(p) || p < 1) continue;
    const circled = Array.isArray(o.circled)
      ? o.circled.filter((c): c is string => typeof c === "string" && insideCircle(c) !== null)
      : [];
    out.push({ p, circled, marks: Array.isArray(o.marks) ? o.marks : [] });
  }
  return out;
}

export type MarksReviewStats = MarkStats & {
  /** 검수 결과를 받은 문단 수 / 전체 문단 수. */
  reviewed: number;
  paragraphs: number;
  /** 갈아 끼운 원문자 수. */
  circledFixed: number;
  /** 개수가 달라 손대지 못한 계열 수(문단 × 계열). */
  circledMismatch: number;
};

/**
 * 원문자를 **계열 안에서** 차례로 갈아 끼운다. 개수가 다른 계열은 손대지 않는다
 * — 짝지을 근거가 없는데 억지로 맞추면 멀쩡한 글자까지 틀리게 만든다
 * (`alignCircledToReference` 와 같은 규칙).
 */
function fixCircled(text: string, want: string[], stats: MarksReviewStats): string {
  const chars = [...text];
  const byFamily = (list: string[]) => {
    const m = new Map<string, string[]>();
    for (const c of list) {
      const f = circledFamily(c);
      if (f) m.set(f, [...(m.get(f) ?? []), c]);
    }
    return m;
  };
  const wantBy = byFamily(want);
  const at = new Map<string, number[]>();
  chars.forEach((c, i) => {
    const f = circledFamily(c);
    if (f) at.set(f, [...(at.get(f) ?? []), i]);
  });
  for (const fam of new Set([...wantBy.keys(), ...at.keys()])) {
    const w = wantBy.get(fam) ?? [];
    const pos = at.get(fam) ?? [];
    if (w.length !== pos.length) {
      stats.circledMismatch++;
      continue;
    }
    pos.forEach((i, k) => {
      if (chars[i] !== w[k]) {
        chars[i] = w[k];
        stats.circledFixed++;
      }
    });
  }
  return chars.join("");
}

/**
 * 검수 결과를 블록에 붙인다. 결과를 못 받은 문단은 **첫 번째 결과를 그대로**
 * 둔다(검수가 게을러 문단을 빠뜨렸다고 이미 있던 밑줄을 지우면 안 된다).
 */
export function applyMarksReview(
  blocks: RichBlock[],
  review: MarksReviewPara[],
): { blocks: RichBlock[]; stats: MarksReviewStats } {
  const stats: MarksReviewStats = {
    ...emptyMarkStats(),
    reviewed: 0,
    paragraphs: 0,
    circledFixed: 0,
    circledMismatch: 0,
  };
  const byP = new Map(review.map((r) => [r.p, r] as const));
  let n = 0;
  const walk = (list: RichBlock[]): RichBlock[] =>
    list.map((b): RichBlock => {
      if (b.kind === "box") return { ...b, blocks: walk(b.blocks) };
      if (b.kind !== "para") return b;
      n += 1;
      stats.paragraphs++;
      const r = byP.get(n);
      if (!r) return b;
      stats.reviewed++;
      const text = fixCircled(b.runs.map((x) => x.t).join(""), r.circled, stats);
      const runs = applyMarks(text, r.marks, stats);
      return runs.length > 0 ? { ...b, runs } : b;
    });
  return { blocks: walk(blocks), stats };
}

/** 검수 결과를 한 줄로(진행 패널·비교 화면). */
export function describeMarksReview(s: MarksReviewStats): string {
  if (s.paragraphs === 0) return "";
  const parts = [`서식 검수 ${s.reviewed}/${s.paragraphs}문단`];
  parts.push(`굵게·밑줄·네모 ${s.total - s.missed}곳`);
  if (s.missed > 0) {
    const shown = s.missedTexts.slice(0, 3).map((t) => `"${t.slice(0, 12)}"`).join(", ");
    parts.push(`${s.missed}곳은 본문에서 못 찾아 뺐어요(${shown})`);
  }
  if (s.circledFixed > 0) parts.push(`원문자 ${s.circledFixed}자 고침`);
  if (s.circledMismatch > 0) parts.push(`원문자 개수가 안 맞아 ${s.circledMismatch}곳은 그대로 둠`);
  return parts.join(" · ");
}
