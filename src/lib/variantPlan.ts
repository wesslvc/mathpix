import { parseJsonObject } from "./problemCompare";

/**
 * **변형문제 계획**(`/variants`) — sol 이 원본 문제를 이해하고, 핵심 논리·쓰이는 계산은 그대로 두되 연산에 들어가는
 * 숫자만 바꾼 변형을 설계해 **그림 모델에 보낼 편집 지시**(`edits`)를 만든다. 순수 모듈(네트워크·환경변수 없음).
 */

export const VARIANT_PROMPT = `task: you are a Korean math/science exam writer. the image is ONE original exam question. (1) read and fully understand it and SOLVE it. (2) identify its core logic and the calculations it relies on. (3) classify the question by HOW it is solved, then design a VARIANT that keeps that solution logic:
 - COMPARISON/ESTIMATION type: the original is solved by comparing sizes, ordering, signs, ratios or rough magnitude, because exact values are hard or impossible to compute. the variant must ALSO be solved by size comparison/estimation only — choose new numbers so the answer is decided by clear inequalities and NOT by exact computation; never make the values come out "clean" so that it becomes a computation problem.
 - COMPUTATION type: same calculation structure with new numbers that keep the results clean (integers/simple fractions stay so), geometry stays valid, conditions ("positive", "distinct", ranges) still hold.
 - PURE CONCEPT/RECALL type (a simple concept check, definitions, 단순 개념): do NOT merely swap numbers or reshuffle choices. write a NEW question of the same unit and similar type that tests a DIFFERENT but related part of that unit (different concept, different example/situation/data). the stem, choices and any figure are then rewritten accordingly, keeping the same format, difficulty and choice layout.
 for the first two types keep the structure, wording, conditions, question type and solution path; change what feeds the logic (numbers, data, positions on axes …).
(4) SOLVE your variant to get its answer; recompute ALL choices ①–⑤ so the right one equals the new answer and the distractors stay plausible (same kind of mistake each distractor encoded in the original). if the answer is a written (주관식) number, give it.
the figure(s) too: list exactly what must change in each figure/graph/table so it matches the new numbers (labels, tick values, bar heights, point coordinates, shaded regions, table cells …) — figures are edited, never copied unchanged, unless they contain no number at all (then say so).
do not change (COMPARISON/COMPUTATION types): the wording, the question stem, the order/layout, the circled markers (㉠ ① ⓐ), answer format, problem number.
write "edits" as ONE self-contained instruction for an image editor that sees only the original image: a numbered list; each item = where it is, the exact original text/value → the exact new text/value; include every changed choice and every figure change; finish with one line "keep everything else exactly as in the original".
"solution" = the 해설지 text printed at the back of a workbook: plain text only (NO LaTeX, NO markdown, NO $ signs) — one step per line, keys of the reasoning first, then the computation with simple characters only (digits, + - × ÷ = ( ) / ; write powers as 제곱/세제곱 or ^, roots as "루트 (…)", and write 이상/이하 instead of ≤ ≥; avoid symbols such as √ ≤ ≥ ≠ π ∠ △ →). for COMPARISON type explain the size argument, not a computation, last line "정답: …". explain the same solution path as the original (or, for a rewritten concept question, the reasoning for the new one).
return JSON only:
{"summary":"한국어 1~2문장: 핵심 논리와 쓰이는 계산","keeps":["그대로 둔 것(논리·계산 유형)"],"kind":"comparison|computation|concept","changes":[{"from":"원래 값/문구","to":"새 값/문구","why":"왜 이렇게 바꿨는지(풀이 논리가 유지되는 이유)"}],"original_answer":"원본의 정답","new_answer":"변형의 정답","solution":"변형 문제의 해설(한국어 평문, 6~18줄)","edits":"그림 모델에 줄 편집 지시 전체"}`;

export type VariantPlan = {
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
    summary: str(obj.summary, 600),
    kind: str(obj.kind, 20),
    keeps: Array.isArray(obj.keeps) ? obj.keeps.slice(0, 20).map((k) => str(k, 200)).filter(Boolean) : [],
    changes,
    originalAnswer: str(obj.original_answer, 100),
    newAnswer: str(obj.new_answer, 100),
    solution: str(obj.solution, 4000),
    edits,
  };
}
