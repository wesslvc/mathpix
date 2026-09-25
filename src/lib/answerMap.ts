/**
 * **문제 번호 → 정답** 표. 사진을 넣자마자 번호를 읽고 이 표로 정답을 붙인다
 * (2026-09-25, 사용자 요청 — "끝나면 자동으로 번호인식하고 자동으로 정답붙고").
 *
 * 출처는 둘이다: 이 실모에 연결된 **채점 기록**(`exam_scores.items`)과 읽어 둔
 * **답지**(`answer_keys.items`). 같은 번호에 서로 다른 답이 있으면(탐구 1·2선택이
 * 한 실모에 같이 붙어 번호가 겹치는 경우 등) **그 번호는 붙이지 않는다** —
 * 잘못 붙이면 엉뚱한 답이 인쇄되고, 안 붙이면 손으로 적으면 된다.
 *
 * 화면(AddProblemFlow)과 서버(page.tsx)가 같이 쓰므로 네트워크 호출도 환경변수도 없다.
 */

export type AnswerEntry = { answer: string; points?: number };
export type AnswerByNumber = Record<number, AnswerEntry>;

type Row = { no: number; answer: string; points?: number };

function rows(list: unknown, answerKey: "correctAnswer" | "answer"): Row[] {
  if (!Array.isArray(list)) return [];
  const out: Row[] = [];
  for (const it of list as Record<string, unknown>[]) {
    const no = Math.floor(Number(it?.no));
    const answer = typeof it?.[answerKey] === "string" ? (it[answerKey] as string).trim() : "";
    if (!Number.isFinite(no) || no < 1 || !answer) continue;
    const points = typeof it.points === "number" && it.points > 0 ? it.points : undefined;
    out.push({ no, answer, ...(points ? { points } : {}) });
  }
  return out;
}

export function buildAnswerMap(
  gradeItems: unknown[],
  answerKeyItems: unknown[],
): AnswerByNumber {
  const all = [
    ...gradeItems.flatMap((items) => rows(items, "correctAnswer")),
    ...answerKeyItems.flatMap((items) => rows(items, "answer")),
  ];
  const map: AnswerByNumber = {};
  const conflict = new Set<number>();
  for (const r of all) {
    const had = map[r.no];
    if (!had) {
      map[r.no] = r.points ? { answer: r.answer, points: r.points } : { answer: r.answer };
    } else if (had.answer !== r.answer) {
      conflict.add(r.no);
    } else if (!had.points && r.points) {
      had.points = r.points;
    }
  }
  for (const no of conflict) delete map[no];
  return map;
}
