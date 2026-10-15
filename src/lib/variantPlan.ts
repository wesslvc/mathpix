import { parseJsonObject } from "./problemCompare";

/**
 * **변형문제 계획**(`/variants`) — sol 이 원본 문제를 이해하고, 핵심 논리·쓰이는 계산은 그대로 두되 연산에 들어가는
 * 숫자만 바꾼 변형을 설계해 **그림 모델에 보낼 편집 지시**(`edits`)를 만든다. 순수 모듈(네트워크·환경변수 없음).
 */

export const VARIANT_PROMPT = `task: you are a Korean math/science exam writer. the image is ONE original exam question. (1) read and fully understand it and SOLVE it. (2) identify its core logic and the calculations it relies on. (3) design a VARIANT: the SAME structure, wording, conditions, question type and solution path — only change the numeric values that feed the computation (given numbers, coefficients, constants, data in tables/graphs, positions on axes …). the variant must stay solvable with the same method and must stay clean: results that were integers/simple fractions stay integers/simple fractions, geometry stays valid (no impossible figures), conditions like "positive", "distinct", ranges still hold. (4) SOLVE your variant to get its answer; recompute ALL choices ①–⑤ so the right one equals the new answer and the distractors stay plausible (same kind of mistake each distractor encoded in the original). if the answer is a written (주관식) number, give it.
the figure(s) too: list exactly what must change in each figure/graph/table so it matches the new numbers (labels, tick values, bar heights, point coordinates, shaded regions, table cells …) — figures are edited, never copied unchanged, unless they contain no number at all (then say so).
do not change: the wording, the question stem, the order/layout, the circled markers (㉠ ① ⓐ), answer format, problem number.
write "edits" as ONE self-contained instruction for an image editor that sees only the original image: a numbered list; each item = where it is, the exact original text/value → the exact new text/value; include every changed choice and every figure change; finish with one line "keep everything else exactly as in the original".
return JSON only:
{"summary":"한국어 1~2문장: 핵심 논리와 쓰이는 계산","keeps":["그대로 둔 것(논리·계산 유형)"],"changes":[{"from":"원래 값/문구","to":"새 값/문구","why":"왜 이렇게 바꿨는지(계산이 깨끗하게 유지되는 이유)"}],"original_answer":"원본의 정답","new_answer":"변형의 정답","solution":"변형 풀이 핵심 3~6줄(한국어)","edits":"그림 모델에 줄 편집 지시 전체"}`;

export type VariantPlan = {
  summary: string;
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
    keeps: Array.isArray(obj.keeps) ? obj.keeps.slice(0, 20).map((k) => str(k, 200)).filter(Boolean) : [],
    changes,
    originalAnswer: str(obj.original_answer, 100),
    newAnswer: str(obj.new_answer, 100),
    solution: str(obj.solution, 1200),
    edits,
  };
}
