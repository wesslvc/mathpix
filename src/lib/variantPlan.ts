import { parseJsonObject } from "./problemCompare";

/**
 * **변형문제 계획**(`/variants`) — sol 이 원본 문제를 이해하고, 핵심 논리·쓰이는 계산은 그대로 두되 연산에 들어가는
 * 숫자만 바꾼 변형을 설계해 **그림 모델에 보낼 편집 지시**(`edits`)를 만든다. 순수 모듈(네트워크·환경변수 없음).
 */

export const VARIANT_PROMPT = `task: you are a Korean math/science exam writer. the image is ONE original exam question. (1) read and fully understand it and SOLVE it. (2) identify its core logic and the calculations it relies on. (3) classify the question by HOW it is solved, then design a VARIANT that keeps that solution logic:
 - COMPARISON/ESTIMATION type: the original is solved by comparing sizes, ordering, signs, ratios or rough magnitude, because exact values are hard or impossible to compute. the variant must ALSO be solved by size comparison/estimation only — choose new numbers so the answer is decided by clear inequalities and NOT by exact computation; never make the values come out "clean" so that it becomes a computation problem.
 - COMPUTATION type: same calculation structure with new numbers that keep the results clean (integers/simple fractions stay so), geometry stays valid, conditions ("positive", "distinct", ranges) still hold.
 - PURE CONCEPT/RECALL type (a simple concept check, definitions, 단순 개념): do NOT merely swap numbers or reshuffle choices. write a NEW question of the same unit and similar type that tests a DIFFERENT but related part of that unit (different concept, different example/situation/data). the stem, choices and any figure are then rewritten accordingly, keeping the same format, difficulty and choice layout.
 for the first two types keep the structure, conditions, question type and solution path (not the wording); change what feeds the logic (numbers, data, positions on axes …).

SETTINGS: after the image(s) you receive a "SETTINGS" block with two knobs. DIFFICULTY (easier / similar / harder) = how hard the variant is to solve relative to the original: easier = fewer or simpler steps, friendlier values, a weaker trap; similar = the same step count and the same difficulty; harder = one more step or a less obvious route, uglier-but-still-valid values, a sharper trap — never beyond the original's grade level, and still exactly one correct answer. NOVELTY (same / slight / new) = how far the variant may leave the original: same = keep the situation, objects, wording and figure layout and change ONLY the values/data that feed the logic; slight = also change the surface setting or data (names, objects, numbers of items, which quantity is asked) but keep the structure and the solution path; new = write a clearly different question of the same unit/type (new situation, new data, new figure) that is solved by the same kind of reasoning. difficulty and novelty are independent; novelty only sets how far the CONTENT may move; the variant must still differ in substance (SUBSTANCE RULE), not just in wording. for CONCEPT/RECALL questions "same" means the same knowledge point tested through different wording/clues, "slight" a closely related item of the unit, "new" a different part of the unit.
SUBSTANCE RULE (replaces rewording; applies at EVERY setting): do NOT try to make the variant feel different by merely rewording the stem or restyling sentences, swapping names/objects, or reordering givens — that is cosmetic and cheap; keep the original's phrasing, layout and presentation close, changing wording only where the content change forces it. make it a different problem by SUBSTANCE, always inside the same course and the TRAP RULE: novelty same = new values only (still not a copy: the numbers must change the intermediate results); novelty slight = ADD one new element to the problem — an extra condition, an extra quantity to find or relate, an extra object/case, a twist in the setup or in what is asked — so the solution path has the same backbone but one new twist; novelty new = a genuinely different problem of the same unit built on the same core idea, with new elements (different configuration, different data, extra condition) — not a reskin. difficulty harder = RAISE THE COMPUTATION LOAD: more terms or steps, an additional simplification or case split, larger or less friendly (but still valid, exactly solvable) numbers, a second-stage calculation that uses the first result — while keeping one correct answer and the course scope; easier = fewer steps and friendlier numbers. for PURE CONCEPT/RECALL questions only, additionally encode the key item as a compressed clue that must be decoded first (e.g. instead of "러시아" write "밀 수출국 1위인 나라"; give a defining feature or characteristic fact instead of the name) — the knowledge tested and the trap stay the same and exactly one choice stays correct. never copy a sentence of the original verbatim when the content change makes it wrong, and never leave a number unchanged when it feeds the logic.
TRAP RULE (applies at EVERY difficulty and novelty setting — settings never switch it off): before designing, find what makes students get THIS question wrong: a peripheral/easy-to-forget concept or condition, a definition boundary or exception, a unit/sign/direction trap, a plausible-looking distractor, an error-prone calculation (many steps, fractions, large or awkward numbers, a subtle simplification) or a trap hidden in the figure/table/graph reading. The variant MUST reproduce each such trap in the same form — the same peripheral concept is still needed, the same kind of complicated calculation structure is still there (same number of steps and the same kind of difficulty even though the values differ), and each distractor still encodes the same kind of mistake. A variant that removes the trap is a failure. list the traps in "traps".
SCOPE RULE (critical, applies at EVERY setting including novelty "new"): first identify the subject and the course/unit of the original (for math: the COMMON courses 수학Ⅰ·수학Ⅱ vs. an elective 미적분 / 확률과 통계 / 기하; for other subjects the exact subject such as 물리학Ⅰ, 생활과 윤리, 한국지리). write it in "course". the variant MUST stay inside that same course and the Korean national curriculum (교육과정) of that course: use only concepts, formulas, theorems and terms that belong to it — never pull in material from outside the curriculum or from another course (e.g. a 수학Ⅱ variant must not need 미적분 or 기하 tools such as the 미적분 techniques beyond 수학Ⅱ, vectors, conics, or 확률과 통계 results; a 확률과 통계 variant must stay in counting/probability/statistics; no university-level shortcuts, no concepts the curriculum does not teach). novelty "new" may change the topic only WITHIN the same course and its units. if you cannot stay in scope with the requested settings, choose the closest in-scope design instead.
CHOICES RULE (critical): in a multiple-choice question every choice ①–⑤ must be rewritten so the printed choices fit the NEW question. The new correct answer MUST appear as exactly one of the printed choices ①–⑤ (and no other choice may also be correct). Never leave the original choices untouched when the numbers/content changed — a variant whose right answer is not among its printed choices is broken. Put ALL FIVE choices into "edits" as items ("① old → new" for each, also the ones that keep their value), and pick which circled number is correct so that it differs from the original position when natural.
(4) SOLVE your variant to get its answer; recompute ALL choices ①–⑤ so the right one equals the new answer and the distractors stay plausible (same kind of mistake each distractor encoded in the original). if the answer is a written (주관식) number, give it.
the figure(s) too: list exactly what must change in each figure/graph/table so it matches the new numbers (labels, tick values, bar heights, point coordinates, shaded regions, table cells …) — figures are edited, never copied unchanged, unless they contain no number at all (then say so).
do not change: the circled markers (㉠ ① ⓐ) system, answer format, problem number, choice count. the stem phrasing and figure presentation stay as close to the original as the content change allows (do not restyle for its own sake); list every added element, changed value and changed choice as an edit.
write "edits" as ONE self-contained instruction for an image editor that sees only the original image: a numbered list; each item = where it is, the exact original text/value → the exact new text/value; include every changed choice and every figure change; finish with one line "keep everything else exactly as in the original".
"solution" = the 해설지 for this variant, written in Mathpix markdown (the same format this app renders): Korean prose with math in $...$ (inline) — use real LaTeX for every symbol and formula (\\sqrt{}, \\le, \\ge, \\ne, \\pi, \\angle, \\triangle, \\to, \\frac{}{}, x^{2} …). one step per paragraph (blank line between steps), the key of the reasoning first, then the computation, last paragraph "정답: …". WRITE THE CLEANEST POSSIBLE SOLUTION: use the shortest, most elegant route that stays strictly inside the course curriculum (the standard method a textbook/teacher would show), minimise the amount of calculation (factor, cancel, use symmetry/known identities before expanding or multiplying out; skip trivial arithmetic), and keep each step to one or two lines. NEVER use decimals in the working: write every non-integer quantity as a fraction ($\\frac{3}{4}$, not 0.75) and keep fractions exact until the final answer (give the final answer in the form the question asks for). no filler sentences, no restating the question. no headings, no bold/italic markers, no tables. for COMPARISON type explain the size argument, not a computation. explain the same solution path as the original (or, for a rewritten concept question, the reasoning for the new one).
return JSON only:
{"course":"과목·과정(예: 수학Ⅱ 공통 / 미적분 / 확률과 통계 / 기하 / 생활과 윤리) — 변형은 이 안에서만","summary":"한국어 1~2문장: 핵심 논리와 쓰이는 계산","keeps":["그대로 둔 것(논리·계산 유형)"],"traps":["원본이 학생을 틀리게 만드는 요소(지엽적 개념·복잡한 연산 구조·함정 선지 등)와 변형에서 어떻게 그대로 살렸는지"],"kind":"comparison|computation|concept","changes":[{"from":"원래 값/문구","to":"새 값/문구","why":"왜 이렇게 바꿨는지(풀이 논리가 유지되는 이유)"}],"original_answer":"원본의 정답","new_answer":"변형의 정답","solution":"변형 문제의 해설(Mathpix 마크다운, 한국어 문장 + $수식$, 6~18문단)","edits":"그림 모델에 줄 편집 지시 전체"}`;

export type VariantLevel = "easier" | "similar" | "harder";
export type VariantNovelty = "same" | "slight" | "new";
export const LEVEL_LABEL: Record<VariantLevel, string> = { easier: "쉽게", similar: "비슷하게", harder: "어렵게" };
export const NOVELTY_LABEL: Record<VariantNovelty, string> = { same: "그대로", slight: "조금 새롭게", new: "새롭게" };

export function readLevel(v: unknown): VariantLevel {
  return v === "easier" || v === "harder" ? v : "similar";
}
export function readNovelty(v: unknown): VariantNovelty {
  return v === "same" || v === "new" ? v : "slight";
}

/** 매번 바뀌는 설정은 **사진 뒤**(꼬리)에 둔다 — 지시문+원본 그림이 앞에서 같아야 프롬프트 캐시에 맞는다. */
export function settingsTail(level: VariantLevel, novelty: VariantNovelty, copy: number, copies: number): string {
  const extra =
    copies > 1
      ? `\nthis is variant ${copy} of ${copies} made from the same original: make it clearly DIFFERENT from the other variants (different values / a different part of the unit), while following every rule above.`
      : "";
  return `\n\nSETTINGS\ndifficulty: ${level}\nnovelty: ${novelty}\n(the TRAP RULE applies regardless of these settings)${extra}`;
}

export type VariantPlan = {
  traps: string[];
  summary: string;
  kind: string;
  keeps: string[];
  changes: { from: string; to: string; why: string }[];
  originalAnswer: string;
  newAnswer: string;
  solution: string;
  edits: string;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** sol 의 JSON 을 읽는다. 편집 지시(`edits`)가 없으면 쓸 수 없으므로 오류다. */
export function parseVariantPlan(text: string): VariantPlan {
  const obj = parseJsonObject(text) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") throw new Error("변형 계획을 읽지 못했습니다.");
  const edits = str(obj.edits, 6000);
  if (edits.length < 10) throw new Error("변형 계획에 편집 지시가 없습니다.");
  const changes = Array.isArray(obj.changes)
    ? obj.changes
        .slice(0, 60)
        .map((c) => {
          const r = (c ?? {}) as Record<string, unknown>;
          return { from: str(r.from, 200), to: str(r.to, 200), why: str(r.why, 300) };
        })
        .filter((c) => c.from || c.to)
    : [];
  return {
    traps: Array.isArray(obj.traps) ? obj.traps.slice(0, 12).map((k) => str(k, 300)).filter(Boolean) : [],
    summary: str(obj.summary, 600),
    kind: str(obj.kind, 20),
    keeps: Array.isArray(obj.keeps) ? obj.keeps.slice(0, 20).map((k) => str(k, 200)).filter(Boolean) : [],
    changes,
    originalAnswer: str(obj.original_answer, 100),
    newAnswer: str(obj.new_answer, 100),
    solution: str(obj.solution, 6000),
    edits,
  };
}

/** sol 이 적은 정답("③", "3", "① 또는…")에서 저장할 답과 유형을 뽑는다. 1~5 한 자리만 객관식. */
export function answerOf(raw: string): { answer: string | null; type: "choice" | "short" } {
  const t = raw.trim();
  if (!t) return { answer: null, type: "short" };
  const circled = "①②③④⑤".indexOf(t[0]);
  if (circled >= 0) return { answer: String(circled + 1), type: "choice" };
  if (/^[1-5]$/.test(t)) return { answer: t, type: "choice" };
  return { answer: t, type: "short" };
}


/**
 * **제작 검수**(변형을 그린 뒤): 기획(설계 JSON)대로 그림이 나왔는지 sol 이 원본과 견준다. 지시문은 고정, 원본 그림이 앞,
 * 만든 그림과 기획은 뒤(꼬리) — 같은 원본의 변형 여럿이 지시문+원본을 캐시로 나눠 쓴다.
 */
export const VARIANT_REVIEW_PROMPT = `task: quality-check a generated VARIANT of a Korean exam question against its PLAN. image 1 = the ORIGINAL question. image 2 = the GENERATED variant picture. the PLAN (JSON: kind, difficulty, novelty, traps, changes, edits, new_answer) is given after the images.
check, in this order, and be strict:
1. EDITS: for every numbered item in plan.edits (and every entry of plan.changes) look at the exact place in image 2: was it applied exactly (right text/value, right position)? 
2. COLLATERAL: compare image 2 with image 1 outside the edits — any other text, number, choice, marker (㉠ ① ⓐ), figure part, table cell or problem number that changed, vanished or got garbled (broken Korean strokes, invented glyphs, dropped words)? 
3. FIGURES: do graphs/diagrams/tables show exactly the NEW values (axis ticks, points, bars, shading, labels)? a figure that still shows old values is an error.
4. ANSWER: first check that the printed choices ①–⑤ in image 2 were really changed to fit the new question (choices identical to image 1 while the question changed is a defect, kind "answer"). Then SOLVE the question as it appears in image 2 (choices ①–⑤ as printed). does the correct choice equal plan.new_answer? is there exactly one correct answer? write what you got in "solved_answer".
5. TRAPS: is each trap listed in plan.traps still present in image 2 in the same form (peripheral concept still needed, same kind of complicated calculation, distractors encoding the same mistakes)? 
6. LOOK: does image 2 differ from image 1 in SUBSTANCE (new values that change the intermediate results; for novelty slight/new an added element or twist; for difficulty harder a larger computation load)? a copy with only a number changed, or one that is merely reworded, is an issue (kind "settings"). do NOT flag it for keeping the original wording or layout.
7. SCOPE: does image 2 stay inside the same course and the Korean curriculum of image 1 (math: common 수학Ⅰ·Ⅱ vs. the same elective 미적분/확률과 통계/기하; plan.course)? any tool, concept or term from outside that course or beyond the curriculum is an issue (kind "settings", say so in "problem").
8. SETTINGS: does the variant match plan.difficulty (easier/similar/harder than the original) and plan.novelty (same = only values changed; slight = surface changed, same structure; new = clearly different question of the same unit)? 
the problem number and handwriting do not matter. an issue is a concrete defect, not a style preference.
return JSON only: {"ok":true|false,"solved_answer":"image 2 에서 직접 푼 정답","answer_matches":true|false,"traps_kept":true|false,"settings_ok":true|false,"issues":[{"kind":"edit|collateral|figure|answer|trap|settings","where":"위치","problem":"무엇이 잘못됐는지(한국어)","fix":"그림 편집기에 줄 한 줄 수정 지시: where → exact value/text it must show (english or korean)"}]}
"ok" is true only when issues is empty. do not invent issues.`;

export type VariantReview = {
  ok: boolean;
  solvedAnswer: string;
  answerMatches: boolean;
  trapsKept: boolean;
  settingsOk: boolean;
  issues: { kind: string; where: string; problem: string; fix: string }[];
};

export function parseVariantReview(text: string): VariantReview {
  const obj = parseJsonObject(text) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") throw new Error("검수 결과를 읽지 못했습니다.");
  const issues = Array.isArray(obj.issues)
    ? obj.issues
        .slice(0, 20)
        .map((c) => {
          const r = (c ?? {}) as Record<string, unknown>;
          return { kind: str(r.kind, 20), where: str(r.where, 200), problem: str(r.problem, 300), fix: str(r.fix, 400) };
        })
        .filter((c) => c.problem || c.fix)
    : [];
  return {
    ok: issues.length === 0,
    solvedAnswer: str(obj.solved_answer, 100),
    answerMatches: obj.answer_matches !== false,
    trapsKept: obj.traps_kept !== false,
    settingsOk: obj.settings_ok !== false,
    issues,
  };
}

/** 검수에서 나온 문제 중 그림 편집기가 고칠 수 있는 것(글·값·그림)을 한 지시로 묶는다. */
export function reviewFixInstruction(r: VariantReview): string {
  const fixes = r.issues.filter((i) => i.fix && i.kind !== "trap" && i.kind !== "settings").map((i, n) => `${n + 1}. ${i.fix}`);
  return fixes.length ? `${fixes.join("\n")}\nkeep everything else exactly as in the picture.` : "";
}
