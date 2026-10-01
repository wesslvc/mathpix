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

MAPS AND DIAGRAMS WITH MARKED POINTS (dots, ×, ●, ▲, labelled locations A/B/C/㉠/가) — be explicit, do both jobs below for every such figure.
(1) POSITION of every point. list each dot/marker in image 1 with a CONCRETE location: relative to printed landmarks (a coastline bend, an island, a river or border, a printed grid / latitude–longitude line, a named region, another dot, an axis) AND an approximate position in % of the figure box (x from the left edge, y from the top edge), e.g. "점 A: 한강 하구 바로 북쪽 해안선 위 (x≈38%, y≈27%)". do the same for image 2, then compare point by point. report kind "figure" when a point is missing / extra / on the wrong side of a landmark / clearly shifted (more than about one dot-width, or across any printed line or boundary) / has a different label; write both concrete locations in "original" and "recreated" so the redraw can be corrected. a dot that sits exactly on a line, boundary or grid crossing in image 1 must sit exactly there in image 2.
(2) TEXT next to a dot — decide PRINT or HANDWRITING explicitly, never leave it unclear:
- PRINT = keep it, and image 2 must contain it at the same dot: labels in the printed typeface identical to the other labels on the figure (A, B, C, ㄱ, ㄴ, 가, 나, 지역 이름), uniform size, aligned to the figure, and above all any label that the question text or the choices refer to ("A 지역", "㉠ 지점") — a referenced label is printed by definition. a printed label that is missing / moved to another dot / changed in image 2 → kind "text" (or "figure" if the dot itself moved).
- HANDWRITING = erase it, and image 2 must NOT contain it: pen/pencil notes with uneven stroke width and letterforms unlike the type, region or place names the student wrote beside a dot, arrows, ticks, circles or extra dots drawn around/at a point, numbers or calculations in the margin of the map, anything the question never mentions and that is not in the printed style. hand-drawn dots (irregular blob, pen-dotted, added by the student) are handwriting too; the printed dots (uniform filled circle like all the other markers) stay. if a handwritten mark overlaps a printed dot/label, the printed one must still be visible in image 2.
- when handwriting is still in image 2 → kind "handwriting", "where" says which point ("지도 점 B 오른쪽 손글씨 '포항'"), "original" = the printed content under it or "빈 자리". when in doubt whether a note beside a dot is printed or handwritten, apply the rule: mentioned by the question or in the same typeface as the other labels → print (keep); otherwise → handwriting (erase). state which one you decided in "where" ("(인쇄 → 유지)" / "(손글씨 → 삭제)").

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

/** sol 이 사용자의 수정 요청을 그림 모델이 알아들을 **구체적인 편집 지시**로 풀어 쓴 것. */
export type PatchPlan = {
  /** 사용자에게 보여 줄 한두 문장("이렇게 이해했어요"). */
  understood: string;
  edits: { where: string; current: string; target: string; how: string }[];
  keep: string;
};

/**
 * **수정 요청 해석 프롬프트**(사용자 — "수정하기 누를 때 sol 이 도와주면 안 돼? 지점 위치 같은 거 내가 계속 얘기해도 못
 * 알아들어"). 그림 편집 모델은 "B 지점을 조금 오른쪽으로" 같은 말을 못 알아듣는다 — 그래서 sol 이 원본과 지금 그림을 둘 다
 * 보고 **어디를 어떻게**를 기준물·퍼센트 좌표로 못박아 준다. 원본(사진 1)이 진실이다.
 */
export function patchPlanPrompt(userText: string, findings: string): string {
  return `task: someone wants to FIX a re-drawn Korean exam question. image 1 = ORIGINAL photo (the truth). image 2 = CURRENT re-drawn version (this is what an image-editing model will edit in place).
the person wrote what to fix, in Korean, possibly vaguely:
"""
${userText.trim() || "(nothing written — use the findings below)"}
"""
${findings ? `earlier automatic findings (image 2 vs image 1):\n${findings}\n` : ""}
you translate this into PRECISE edit instructions for an image-editing model that cannot understand vague location words ("here", "a bit to the right", "near B") and only sees image 2.
do a DETAILED COMPARISON first, then write the edits as STRONG imperative commands (MOVE / ERASE / REPLACE … "exactly", "do not") — the image-editing model ignores soft wording, so be forceful and numeric. for EACH fix:
- find the thing in BOTH images, and also check every neighbouring point / label / element the fix could plausibly involve (the person often names only one of several that are off).
- POINTS / DOTS / MARKERS on maps, graphs, figures: give its position in image 1 (the target) and in image 2 (the current) relative to printed landmarks (a coastline bend, an island, a river or border, a printed grid / latitude–longitude line, an axis, a labelled neighbour, nearby printed text) AND as % of the figure box (x from the left edge, y from the top edge). then say exactly how to move it: direction + distance in % of the figure width/height + the landmark it must end up on or beside ("move point B about 6% of the figure width to the left so it sits exactly on the crossing of the 37°N line and the coast").
- TEXT: quote the exact current text and the exact target text (from image 1), and where it sits.
- HANDWRITING: say which marks to erase and where; what printed content is under them (or "clean white paper").
- give a checkable success condition ("B must end within ~2% of x=56%, y=41%, on the 37°N line").
- say what must NOT change around it.
if the request is ambiguous or contradicts image 1, pick the reading that makes image 2 match image 1 and say so in "understood". if it asks for something that is not visible / not possible, say so instead of inventing.
write "understood" in Korean (1–2 short sentences: what you understood, so the person can check). write edits in English or Korean, whichever is clearer, but keep quotes exact.
return JSON only:
{"understood":"...","edits":[{"where":"short location","current":"what image 2 has now (with position)","target":"what it must be (with position, from image 1)","how":"the concrete edit"}],"keep":"what to leave untouched"}`;
}

/** 해석 결과를 읽는다. 모양이 이상하면 던진다(부르는 쪽이 사용자 글 그대로 진행한다). */
export function parsePatchPlan(text: string): PatchPlan {
  const obj = parseJsonObject(text) as Record<string, unknown> | null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const list = Array.isArray(obj?.edits) ? (obj!.edits as unknown[]) : [];
  const edits: PatchPlan["edits"] = [];
  for (const e of list.slice(0, 20)) {
    const r = e as Record<string, unknown> | null;
    if (!r || typeof r !== "object") continue;
    const item = {
      where: str(r.where, 200),
      current: str(r.current, 400),
      target: str(r.target, 400),
      how: str(r.how, 500),
    };
    if (item.target || item.how) edits.push(item);
  }
  if (edits.length === 0) throw new Error("수정 해석 결과에 고칠 곳이 없습니다.");
  return { understood: str(obj?.understood, 400), edits, keep: str(obj?.keep, 400) };
}

/** 수정 대화 한 마디. */
export type ChatTurn = { role: "user" | "assistant"; text: string };

/**
 * **수정 대화 프롬프트**(사용자 — "수정모드 때는 sol 과 LLM 형태로 대화해서 수정사항을 최종 확정시키자"). sol 이 원본(사진 1)과 지금
 * 그림(사진 2)을 보며 사용자와 **주고받는다**: 무엇이 어떻게 다른지 보이는 대로 말하고, 위치가 모호하면 되묻고, 합의된 수정 사항을
 * 매번 `plan` 으로 정리해 돌려준다. 사용자가 그 plan 을 보고 "확정"을 누르면 그대로 그림 모델에 간다.
 *  - `patch`  : 사진 2 를 **그 자리에서 고친다**(수정 사항 = 사진 2 에 가할 편집).
 *  - `redraw` : 사진 1 에서 **처음부터 다시 그린다**(사진 2 는 지난 시도 — 수정 사항 = 이번에 틀리지 말아야 할 곳).
 */
/**
 * 수정 대화 프롬프트. **바뀌지 않는 지시문(`head`)을 사진 앞에, 대화 내용(`tail`)을 사진 뒤에** 둔다 — 프롬프트
 * 캐시는 앞에서부터 같은 부분까지만 맞으므로, 대화가 사진 앞에 있으면 마디마다 거기서 끊긴다. 이렇게 두면
 * 두 번째 마디부터는 지시문 + 사진 두 장이 캐시에 맞는다.
 */
export function solChatPrompt(
  goal: "patch" | "redraw",
  turns: ChatTurn[],
  findings: string,
): { head: string; tail: string } {
  const what =
    goal === "patch"
      ? "image 2 will be EDITED IN PLACE by an image-editing model, so every plan item is an edit to image 2."
      : "image 2 is only the previous attempt; the next drawing is made from image 1 again, so every plan item is something the NEXT drawing must get right (based on what went wrong in image 2)."
  ;
  const talk = turns.map((t) => `${t.role === "user" ? "PERSON" : "YOU"}: ${t.text.trim().slice(0, 1500)}`).join("\n");
  const head = `task: you are chatting (in Korean) with a person who is fixing a re-drawn Korean exam question. image 1 = ORIGINAL photo (the truth). image 2 = the CURRENT re-drawn version. ${what}
${findings ? `automatic findings from an earlier comparison (may help, may be incomplete):\n${findings}\n` : ""}the conversation so far comes AFTER the two images.
reply to the LAST person message like a careful assistant:
- LOOK at both images. say what you actually see that is different around what they mean ("점 B 는 원본에서 해안선 꺾이는 곳 위인데 지금 그림은 약 6% 오른쪽에 있어요"). be concrete: printed landmarks + % of the figure box.
- if the location / target is ambiguous, or you cannot see it, ASK one short question instead of guessing. never invent what is not in the images.
- if they ask for something that makes the drawing differ from image 1 (changing question text / numbers / answer choices), say that the drawing must match the original and offer the reading that does.
- keep it short (2–5 sentences). no markdown headings.
also, every turn, output the CURRENT AGREED PLAN as "plan" — everything agreed so far in this conversation (not only the last message), as PRECISE, FORCEFUL instructions an image model can follow (MOVE/ERASE/REPLACE … exactly, with numeric % positions and a landmark; quote exact text). "understood" = 1–2 Korean sentences summarising the plan. if nothing concrete is agreed yet (you are asking a question), set "plan" to null.
return JSON only:
{"reply":"한국어 답변","plan":null or {"understood":"...","edits":[{"where":"short location","current":"what image 2 has now (with position)","target":"what it must be (with position, from image 1)","how":"the concrete edit"}],"keep":"what to leave untouched"}}`;
  const tail = `conversation so far:
${talk}

reply to the LAST person message (JSON only, as described above).`;
  return { head, tail };
}

/** 대화 답을 읽는다. `plan` 이 이상하면 없는 것으로 친다(답변 글은 살린다). */
export function parseSolChat(text: string): { reply: string; plan: PatchPlan | null } {
  const obj = parseJsonObject(text) as Record<string, unknown> | null;
  const reply = typeof obj?.reply === "string" ? obj.reply.trim().slice(0, 2000) : "";
  if (!reply) throw new Error("sol 답변이 비어 있습니다.");
  let plan: PatchPlan | null = null;
  if (obj?.plan && typeof obj.plan === "object") {
    try {
      plan = parsePatchPlan(JSON.stringify(obj.plan));
    } catch {
      plan = null;
    }
  }
  return { reply, plan };
}

/** 해석 결과를 그림 편집 모델에 줄 지시 글로. */
export function planToChanges(plan: PatchPlan): string {
  const lines = plan.edits.map(
    (e, i) =>
      `${i + 1}. ${e.where ? `[${e.where}] ` : ""}${e.how || `change "${e.current}" → "${e.target}"`}` +
      `${e.current ? ` | now: ${e.current}` : ""}${e.target ? ` | must be: ${e.target}` : ""}`,
  );
  return `${lines.join("\n")}${plan.keep ? `\nkeep unchanged: ${plan.keep}` : ""}`;
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

// ── sol 이 읽고 우리가 조판하기 (수정 창 전용) ─────────────────────────────

/** 옮겨 적기에서 글자로 못 옮긴 그림 하나(사진 대비 비율 0~1). */
export type TranscribedFigure = { id: string; x: number; y: number; w: number; h: number };
export type Transcription = { text: string; figures: TranscribedFigure[] };

/**
 * **sol 이 문제 한 장을 글자로 옮겨 적는다** — 그 글을 우리 인식 경로(`renderMathText` · 카드 조립)가 그대로 조판한다.
 * 출력 꼴은 이 앱의 인식 경로가 이미 그리는 Mathpix mmd 에 맞춘다: `$…$`/`$$…$$` 수식, 빈 줄로 문단, `> ` 로 조건 박스,
 * `(가)`/`(나)` 표지, `<보기>` 머리글과 ㄱ. ㄴ. ㄷ. 항목, 마크다운 표.
 *
 * 그림은 글자로 못 옮기는 것(그래프·도형·지도·사진·도식)만이다. 글자만 든 표는 표로 옮긴다 — 그림으로 넘기면 표 안 글자가
 * 원본 사진 조각으로 남아 조판한 글과 서체가 갈린다. 예전 비교 화면의 ③(9850a04)을 수정 창으로 옮겨 온 것이다.
 */
export const TYPESET_PROMPT = `task: transcribe ONE Korean exam question from the photo so it can be re-typeset by our renderer. text accuracy is the whole point — every printed character exactly as printed. never paraphrase, never fix the question, never solve it.

ignore handwriting (student's pencil/pen marks, circles, check marks, scribbles, written answers, margin calculations). keep only what is PRINTED. printed underlines / bold that belong to the question are kept (see below).

output format for "text" (markdown-like, rendered by our typesetter):
- question number at the start as printed, e.g. "17. " .
- paragraphs separated by one blank line. do not add line breaks inside a sentence.
- ALL math in LaTeX: inline $...$, display $$...$$ on its own line. expressions inside sentences (e.g. $f(x)$, $x=3$, $\\frac{1}{2}$, $\\overline{AB}$) go in $...$. plain Korean counting like "3개" may stay plain.
- a condition box printed with a border: each line of the box prefixed with "> ". (가)/(나)/(다) conditions keep their markers "(가)", "(나)".
- <보기> box: a line "<보기>" then one item per line: "ㄱ. ...", "ㄴ. ...", "ㄷ. ...". use the compatibility jamo ㄱ ㄴ ㄷ (U+3131…), not conjoining jamo.
- a table made only of text/numbers: markdown table ("| a | b |" rows, second row "| --- | --- |"). keep every cell, keep empty cells empty.
- choices: each line as printed, e.g. "① 1  ② 2  ③ 3  ④ 4  ⑤ 5" on one line if printed on one line; math choices as "① $\\frac{1}{2}$".
- circled markers (㉠㉡㉢ ①② ⓐⓑ ㉮㉯) as those exact unicode characters. read the character INSIDE each circle carefully; never guess from neighbours and never switch families (㉠ is not ①).
- printed underline (the question often points at it, e.g. "밑줄 친 ㉠"): $\\underline{\\text{밑줄 친 말}}$ for Korean words, \\underline{...} inside math. keep the circled marker OUTSIDE the underline unless it is printed under the line. printed bold: write the words plainly (our typesetter has no bold); never use <u>, ** or HTML tags.
- a fraction whose numerator/denominator are Korean words: $\\frac{\\text{분자}}{\\text{분모}}$ — keep it stacked, never flatten it into one line.
- Middle Korean / archaic Hangul (중세 국어: syllables with ㆍ arae-a, ㅿ, ㆁ, ㅸ, clusters like ᄢ ᄠ, final ᆰ etc.): write each archaic syllable as a sequence of Hangul CONJOINING jamo — initial (U+1100–115F, U+A960–A97F), medial (U+1160–11A7, U+D7B0–D7C6; arae-a is U+119E ᆞ), optional final (U+11A8–11FF, U+D7CB–D7FB). e.g. ᄃᆞᆰ = U+1103 U+119E U+11B0, ᄆᆞᆯ = U+1106 U+119E U+11AF. our typesetter assembles them into one syllable. never approximate with separate letters and a dot ("ㄷ·ㄺ", "ㄷ ㆍ ㄹㄱ"), and never drop them. modern syllables stay ordinary precomposed Hangul (가–힣). letters quoted alone as letters (e.g. ‘ㅛ’, ‘ㅣ’) stay ordinary compatibility jamo.

figures: anything that cannot be written as text or a simple table — graph, geometric figure, diagram, map, photo, chart, apparatus, a table containing pictures. for each figure:
- put a line "[[FIG fN]]" (N = 1,2,…) as its own paragraph where it sits in the reading order.
- give its box in "figures" with box_2d [ymin, xmin, ymax, xmax] normalised 0-1000 to THIS image, tight around the figure including its own labels/caption but NOT the surrounding sentences.
- do NOT also transcribe the text drawn inside the figure (axis labels, numbers on the graph, map names) — it stays in the picture.

return JSON only:
{"text":"...","figures":[{"id":"f1","box_2d":[ymin,xmin,ymax,xmax]}]}`;

/** 옮겨 적기 결과를 읽는다. 모양이 이상한 그림은 버린다(그 자리 표시는 조판할 때 빠진다). */
export function parseTranscription(text: string): Transcription {
  const obj = parseJsonObject(text) as { text?: unknown; figures?: unknown };
  const body = typeof obj?.text === "string" ? obj.text : "";
  if (!body.trim()) throw new Error("옮겨 적은 글이 비어 있습니다.");
  const figures: TranscribedFigure[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.figures)) {
    for (const f of obj.figures.slice(0, 12)) {
      if (!f || typeof f !== "object") continue;
      const r = f as { id?: unknown; box_2d?: unknown };
      const id = typeof r.id === "string" && /^f\d{1,2}$/.test(r.id) ? r.id : null;
      const b = Array.isArray(r.box_2d) ? r.box_2d.map(Number) : null;
      if (!id || seen.has(id) || !b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) continue;
      const [y0, x0, y1, x1] = b.map((n) => Math.min(1000, Math.max(0, n)) / 1000);
      if (x1 - x0 < 0.01 || y1 - y0 < 0.01) continue;
      seen.add(id);
      figures.push({ id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return { text: body.replace(/\r\n/g, "\n").trim().slice(0, 20000), figures };
}

/** 본문에서 그림 자리 표시 줄. */
export const FIG_MARKER = /^\s*\[\[FIG (f\d{1,2})\]\]\s*$/;

/**
 * 본문을 그림 자리 표시 기준으로 나눈다. `before` 는 그 그림 앞까지의 본문(자리 계산용), `text` 는 표시를 뺀 본문 전체다.
 * 본문에 표시가 없는 그림은 부르는 쪽이 맨 아래에 붙인다.
 */
export function splitFigureMarkers(text: string): {
  text: string;
  markers: { id: string; before: string }[];
} {
  // 표시가 문단 한가운데·문장 속에 끼어 와도 제 문단으로 떼어 낸다 — 안 그러면 "[[FIG f1]]" 글자가 그대로 인쇄된다.
  const paras = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]*\[\[FIG (f\d{1,2})\]\][ \t]*/g, "\n\n[[FIG $1]]\n\n")
    .split(/\n\s*\n/)
    .filter((p) => p.trim());
  const kept: string[] = [];
  const markers: { id: string; before: string }[] = [];
  for (const p of paras) {
    const m = p.match(FIG_MARKER);
    if (m) {
      markers.push({ id: m[1], before: kept.join("\n\n") });
      continue;
    }
    kept.push(p);
  }
  return { text: kept.join("\n\n"), markers };
}
