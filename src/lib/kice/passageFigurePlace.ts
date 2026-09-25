import type { RichBlock } from "./richText";

/**
 * 지문 안 그림을 **sol 이 짚은 자리에** 붙인다. 브라우저(`passageFigures.ts`, 수정
 * 화면의 다시 인식하기)와 서버 일꾼(`passageRun.ts`)이 같이 쓴다 — 규칙이 둘로
 * 갈리면 같은 지문이 넣을 때와 고칠 때 다르게 나온다.
 *
 * - sol 은 그림을 `f1`, `f2`… 로 짚는다(보낸 차례).
 * - **자리를 못 짚은 그림은 지문 끝에** 붙인다 — 버리지 않는다.
 * - 우리가 넘기지 않은 id 는 붙일 그림이 없다 — 빈 자리를 남기지 않게 뺀다.
 *
 * 네트워크 호출도 환경변수도 없다.
 */

export type PlacedFigure = { src: string; ratio: number; scale: number };

/** 블록 안의 figure id 를 읽는 차례대로. */
function figureIds(blocks: RichBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "box") out.push(...figureIds(b.blocks));
    else if (b.kind === "figure") out.push(b.id);
  }
  return out;
}

/** `made[i]` 가 `f{i+1}` 에 붙는다. 돌려주는 `missing` 은 지문 끝에 붙인 개수. */
export function placePassageFigures(
  blocks: RichBlock[],
  made: PlacedFigure[],
): { blocks: RichBlock[]; missing: number } {
  if (made.length === 0) return { blocks, missing: 0 };
  const idOf = (i: number) => `f${i + 1}`;
  const placed = new Set(figureIds(blocks).filter((id) => /^f\d+$/.test(id)));
  const missing = made.map((_, i) => idOf(i)).filter((id) => !placed.has(id));

  const fill = (list: RichBlock[]): RichBlock[] =>
    list.flatMap((b): RichBlock[] => {
      if (b.kind === "box") return [{ ...b, blocks: fill(b.blocks) }];
      if (b.kind !== "figure") return [b];
      const m = /^f(\d+)$/.exec(b.id);
      const got = m ? made[Number(m[1]) - 1] : undefined;
      if (!got) return [];
      return [{ kind: "figure", id: b.id, ratio: got.ratio, src: got.src, scale: got.scale }];
    });
  return {
    blocks: fill([...blocks, ...missing.map((id) => ({ kind: "figure" as const, id, ratio: 1 }))]),
    missing: missing.length,
  };
}
