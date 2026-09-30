// **문제 글자 정확도 비교**(`/admin/compare-problem`)의 프롬프트와 해석.
//
// 2026-09-30 사용자 요청 — "이미지 생성 방식이라 텍스트 정확도가 많이 떨어진다,
// sol 6.1 로 개선하는 방안". 운영(sunburst 한 번) · ① 같은 그리기에 quality 만 올림 ·
// ② sol 이 원본과 대조해 틀린 곳을 지시로 붙여 다시 그리기 를 견준다.
// (③ "sol 이 본문을 글자로 옮기고 우리가 조판" 은 폐기했다 — git 이력에 있다.)
//
// 세 방식의 결과를 **같은 대조 프롬프트**(`VERIFY_PROMPT`)로 원본과 견준다 —
// 그래야 "남은 차이"가 같은 잣대로 센 숫자가 된다.
//
// 이 파일에는 네트워크 호출도 환경변수도 없다(화면과 서버가 같이 쓴다).

import { circledCharsIn, circledPairs } from "./circledChars";

/**
 * 차이의 종류. `text` 글자가 다르다 · `glyph` **깨진 글자**(뭉개지거나 획이 빠지거나 없는
 * 글자를 지어낸 것) · `figure` **도형·그림**의 모양·개수·위치·표시가 다르다.
 * 모델이 안 적으면 `text` 로 본다(옛 응답과 같다).
 */
export type DiffKind = "text" | "glyph" | "figure" | "handwriting";

/** 원본과 다시 만든 것 사이의 차이 하나(글자·깨진 글자·도형·손글씨 잔재). */
export type TextDiff = {
  kind?: DiffKind;
  /** 원본(사진 1)에 인쇄된 글자. 손글씨 잔재면 그 자리에 **가려져 있던 인쇄 내용**(없으면 "빈 자리"). */
  original: string;
  /** 다시 만든 것(사진 2)에 보이는 글자. 빠졌으면 빈 글자. 손글씨 잔재면 남아 있는 필기의 모양. */
  recreated: string;
  /** 어디쯤인지(짧게). */
  where: string;
};

/**
 * 대조 프롬프트. 사진 1 = 원본(손글씨가 있을 수 있다), 사진 2 = 다시 만든 것.
 *
 * **글자만 본다** — 글꼴·줄바꿈·간격·배치·그림 화풍은 다 달라도 된다. 그걸
 * 세기 시작하면 ③(우리가 조판)은 언제나 "다르다"가 되어 비교가 안 된다.
 * 손글씨는 원본에만 있고 지우는 게 맞으므로 차이로 치지 않는다.
 */
export const VERIFY_PROMPT = `task: proofread a re-created Korean exam question against the original photo.
image 1 = ORIGINAL photo of the printed question (may contain a student's handwriting — pencil/pen marks, circles, scribbles, answers, working).
image 2 = RE-CREATED version of the same question. it must contain the PRINTED content only: all handwriting must be gone.

find every place where image 2 differs from image 1. four kinds — set "kind" for each:
"text"   = printed text differs, "glyph" = broken/garbled characters, "figure" = a figure/diagram/graph/table drawing differs,
"handwriting" = student handwriting from image 1 is still visible in image 2 (or a printed mark was wrongly erased with it).

kind "text" — the PRINTED TEXT of image 2 differs from image 1:
- wrong, missing or extra characters (한글, 한자, 영문), words, numbers, units, signs
- math: wrong symbols, exponents, subscripts, fractions (numerator/denominator), inequality direction, variables
- circled markers (㉠㉡ ①② ⓐⓑ ㉮㉯) and choice numbers — a wrong or swapped marker IS a difference
- negations and key words (옳은 ↔ 옳지 않은, 않는, 아닌, 최대/최소 ...) — highest priority
- circled markers — see the block below, highest priority too
- lines/sentences/choices that are missing or duplicated
- text inside tables and figure labels (axis labels, numbers on graphs, legend) also counts

kind "glyph" — BROKEN CHARACTERS. image generators often melt or invent glyphs. go through image 2 line by line, zoomed in, and flag any character that is:
- malformed: strokes merged/missing/extra, half-formed, smeared, or a pseudo-character that is not a real 한글/한자/letter/digit/symbol
- a look-alike swap: ㅏ↔ㅓ, ㅗ↔ㅜ, ㅂ↔ㅁ, ㅇ↔ㅁ, 0↔O, 1↔l↔I, 5↔S, x↔×, ㄴ↔ㄱ, 己↔已, a wrong 받침
- an unreadable blob where image 1 has readable text
in "recreated" write what you actually see ("깨짐: ㅂ 획이 뭉개져 ㅁ 처럼 보임"); in "original" write the intended real character/word from image 1. these count even if you cannot tell what was meant.

kind "figure" — FIGURE DETAIL. compare every graph, geometric figure, diagram, map, apparatus, chart and table drawing element by element, zoomed in. report when:
- a shape, curve, line, arrow, point or region is missing, extra, or a different shape (e.g. concave vs convex, wrong number of peaks, parabola opening the wrong way)
- counts differ (ticks, layers, particles, cells, dots, arrows, bars, rows, columns)
- a labelled point (A, B, P, O …) or label sits at a different place, is missing, or belongs to another point
- lines that should meet at one point (intersections, tangent points, axis crossings, maxima/minima) do not, or a line grazes instead of passing exactly through / touching at exactly one point
- axes, origin O, tick numbers, units, asymptotes, dashed vs solid lines, angle arcs, right-angle marks, equal-length hatches, arrowheads, shaded regions, legend swatches differ
- a table drawing has wrong cell contents, merged cells split/merged wrongly, or a row/column missing
describe both sides concretely ("원본: 점 P 가 직선 l 위에 있음" / "그림: P 가 l 에서 떨어져 있음"). colour or line-thickness differences alone are NOT differences.

kind "handwriting" — YOU decide what is handwriting, and it must be ERASED. first scan image 1 for every handwritten mark: pencil/pen/highlighter notes, working, answers written in margins or blanks, circles/ellipses around choices or words, ticks/crosses/stars/arrows, underlines drawn by hand, scribbled-out text, grading marks. black ballpoint counts as handwriting too — do NOT use colour as the test. tell handwriting from print by: uneven stroke width, slightly wavy/slanted lines, letterforms unlike the type, pencil grey or coloured pen, marks that start mid-word or spill outside the printed layout / ruled boxes, anything overlapping printed text. then check image 2 at the same spots:
- the mark (or a cleaned-up copy of it) is still there → report kind "handwriting": "recreated" = what remains ("선택지 ③ 둘레의 손으로 그린 동그라미"), "original" = the PRINTED content that sits under it ("선택지 ③ 본문", or "빈 자리" if nothing is printed there)
- the region under a removed mark is blank/garbled instead of the printed content that was hidden → report it as kind "text" (or "glyph")
- a PRINTED underline / bold / box / circled marker that image 1 really has (perfectly straight, same stroke as the type, aligned to the text) is missing in image 2 → kind "text": printed emphasis is part of the question. never confuse it with a hand-drawn underline
- when a student wrote the answer into a printed blank or box, the blank/box must be empty in image 2

circled markers (㉠㉡㉢ / ㉮㉯㉰ / ①②③ / ⓐⓑⓒ) — YOU are the only one checking these. the drawing model was NOT told how to draw them, so expect mistakes:
- first list every circled marker in image 1 in reading order (stem, boxes, <보기>, tables, choices) by its INNER glyph: ㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭=ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ; ㉮㉯㉰㉱㉲=가나다라마; ①..⑳=1..20; ⓐⓑⓒⓓⓔ=a b c d e. read each circle separately, zoomed in. never infer one from its neighbours (a question may use only ㉡ and ㉣, or repeat ㉠ four times)
- list image 2 the same way and compare position by position
- report a difference when the inner glyph differs, the family changes (㉠→① / ㉠→㉮), a marker is missing / extra / renumbered, a circle is drawn as a square / parenthesis / bare character, or the same marker looks different in different places
- in "recreated" write the inner glyph you actually see, e.g. "㉡ (inner ㄴ)"

do NOT report: font, size, spacing, line breaks, alignment, box/table border style, line thickness / colour / shading style of figures, image quality, the same math written in different but equivalent notation. handwriting that image 2 correctly removed is NOT a difference.
be precise — quote the exact characters. if you are not sure a difference exists, do not report it.

return JSON only:
{"diffs":[{"kind":"text|glyph|figure|handwriting","original":"exact printed text (or figure detail) in image 1","recreated":"what image 2 shows instead (\\"\\" if missing)","where":"short location, e.g. 발문 2줄 / 선택지 ③ / 표 2행 / 그래프 왼쪽"}]}
return {"diffs":[]} if image 2 matches image 1 in text, glyphs and figures and no handwriting remains.`;

/** 대조 결과를 읽는다. 모양이 이상한 항목은 버린다. */
export function parseVerify(text: string): TextDiff[] {
  const obj = parseJsonObject(text);
  const list = (obj as { diffs?: unknown })?.diffs;
  if (!Array.isArray(list)) throw new Error("대조 결과를 읽지 못했습니다.");
  const out: TextDiff[] = [];
  for (const d of list.slice(0, 80)) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const original = typeof r.original === "string" ? r.original : "";
    const recreated = typeof r.recreated === "string" ? r.recreated : "";
    const where = typeof r.where === "string" ? r.where : "";
    const kind: DiffKind =
      r.kind === "glyph" || r.kind === "figure" || r.kind === "handwriting" ? r.kind : "text";
    if (!original && !recreated) continue;
    if (original === recreated) continue;
    out.push({ kind, original, recreated, where });
  }
  return out;
}

/** 한 라운드(그 quality 로 그린 그림)를 검수해 나온 차이. */
export type RoundDiffs = { quality: string; diffs: TextDiff[] };

/**
 * 차이 하나를 "원본대로 고치라"는 한 줄로. 내용을 바꾸라는 요청이 아니라 원본과 같게 되돌리라는
 * 요청이다(`withInstruction` 이 "그리는 방식만 받는다, 원본 베끼기가 이긴다"로 감싼다).
 */
function describeDiff(d: TextDiff, n: number): string {
  const got = d.recreated ? `"${d.recreated}"` : "(빠짐)";
  const at = d.where ? `[${d.where}] ` : "";
  if (d.kind === "figure") {
    return `${n}. ${at}도형: 원본은 "${d.original}" 인데 앞선 시도에서는 ${got} 였다 — 원본 그림과 똑같이 그린다.`;
  }
  if (d.kind === "handwriting") {
    const under =
      d.original && d.original !== "빈 자리"
        ? ` 그 밑에 가려져 있던 인쇄 내용("${d.original}")은 또렷하게 되살려 그린다.`
        : " 그 자리는 깨끗한 흰 종이로 둔다.";
    return `${n}. ${at}손글씨 잔재: ${got} 는 학생이 손으로 쓴 필기이므로 완전히 지운다(흔적·번짐도 남기지 않는다).${under} 인쇄된 밑줄·굵은 글씨는 지우지 않는다.`;
  }
  if (d.kind === "glyph") {
    return `${n}. ${at}깨진 글자: 원본 "${d.original}" 을(를) 앞선 시도에서 ${got} 로 뭉개 그렸다 — 획 하나하나 또렷한 진짜 글자로 그린다.`;
  }
  return `${n}. ${at}원본 "${d.original}" 인데 앞선 시도에서 ${got} 로 그렸다.`;
}

function correctionBody(diffs: TextDiff[], intro: string): string {
  const lines = diffs.slice(0, 20).map((d, i) => describeDiff(d, i + 1));
  // 그림 모델은 원문자 그리는 법을 프롬프트로 못 받는다(원문자는 sol 이 지킨다). 그래서 틀린 원문자가
  // 있으면 **여기서** 안쪽 글자를 짚어 준다 — 동그라미 안에 무엇인지가 핵심이다.
  const circled = circledCharsIn(diffs.filter((d) => d.kind !== "handwriting").map((d) => d.original).join(" "));
  const circledLine = circled.length
    ? `\n원문자는 글자 하나로 외워 그리지 말고 얇은 원을 긋고 그 안 가운데에 글자를 넣어 그린다: ${circledPairs(circled)}. 같은 표지는 어디서나 똑같이, 계열(㉠→①)을 넘나들지 말 것.`
    : "";
  return `${intro}
${lines.join("\n")}${circledLine}`;
}

/** ② 다시 그리기에 붙일 지시(방금 검수가 찾은 차이만). */
export function correctionInstruction(diffs: TextDiff[]): string {
  return correctionBody(
    diffs,
    "앞선 시도에서 아래가 원본 사진과 달랐다(글자·깨진 글자·도형·남은 손글씨). 이번에는 사진과 똑같이 그려라(나머지도 그대로 베낀다):",
  );
}

/**
 * **앞선 모든 시도의 실수를 한데 모은 지시.** 다시 그릴 때 입력은 늘 **원본**이고 앞 시도가 그린 그림은
 * 모델에게 보여 주지 않는다(폐기) — 그림을 다시 입력으로 넣으면 고친 그림을 또 베끼면서 흐려지는
 * "풍화"가 생긴다(사용자 지적). 대신 **지난 시도들이 어디서 틀렸는지만** 주의사항으로 넘긴다.
 * 여러 라운드에서 되풀이된 실수는 이 모델이 특히 잘 틀리는 자리라 앞에 놓는다.
 */
export function accumulatedCorrection(history: RoundDiffs[]): string {
  type Item = { diff: TextDiff; rounds: Set<string>; recreated: Set<string> };
  const byKey = new Map<string, Item>();
  for (const h of history) {
    for (const d of h.diffs) {
      const key = `${d.kind ?? "text"}|${d.original}`;
      const cur = byKey.get(key) ?? { diff: d, rounds: new Set<string>(), recreated: new Set<string>() };
      cur.rounds.add(h.quality);
      if (d.recreated) cur.recreated.add(d.recreated);
      byKey.set(key, cur);
    }
  }
  const items = [...byKey.values()].sort((a, b) => b.rounds.size - a.rounds.size);
  const merged: TextDiff[] = items.map((it) => ({
    ...it.diff,
    recreated: [...it.recreated].join("\" 또는 \""),
    where: it.rounds.size > 1 ? `${it.diff.where ? `${it.diff.where}, ` : ""}${[...it.rounds].join("·")} 에서 되풀이` : it.diff.where,
  }));
  const tried = history.map((h) => h.quality).join("·");
  return correctionBody(
    merged,
    `앞선 시도(${tried})에서 아래가 원본 사진과 달랐다(글자·깨진 글자·도형·남은 손글씨). 앞선 그림은 버렸다 — 이번에는 사진만 보고, 아래 실수를 되풀이하지 말고 사진과 똑같이 그려라(나머지도 그대로 베낀다):`,
  );
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("모델 응답이 JSON 이 아닙니다.");
    return JSON.parse(text.slice(a, b + 1));
  }
}
