/**
 * 지면 위의 "문제 영역" 좌표를 다루는 규칙.
 *
 * **서버(영역 자동 찾기)와 화면(손으로 합치기)이 똑같이 써야 해서** 여기 따로
 * 뒀다. 양쪽에 따로 적으면 반드시 어긋난다 — 같은 조각을 두고 서버는 하나로
 * 합치고 화면은 이어 붙이는 식이 되면 결과물이 달라진다.
 *
 * 브라우저에도 실려야 하므로 이 파일에는 **네트워크 호출도 환경변수도 없다.**
 */

/** 0~1 로 정규화된 영역. 왼쪽 위가 (0,0). */
export type ProblemBox = { x: number; y: number; w: number; h: number };

/** 어느 단에 있는가. 0 = 왼쪽, 1 = 오른쪽. */
export const columnOf = (b: ProblemBox) => (b.x + b.w / 2 < 0.5 ? 0 : 1);

/**
 * 같은 단에 있는 조각들을 **둘을 아우르는 네모 하나로** 만든다.
 *
 * 같은 단에서 위아래로 놓인 조각을 이어 붙이면, 조각마다 폭을 다시 맞추고
 * 사이에 띠를 넣는 바람에 원래 한 덩어리였던 것이 **잘렸다 붙인 티가 난다.**
 * 같은 단이면 그냥 아우르는 네모로 잘라내면 원본 그대로다.
 *
 * 돌려주는 것은 **단마다 하나씩, 왼쪽 단이 먼저**다(읽는 차례). 길이가 2면
 * 단을 넘어간 문제라 세로로 이어 붙여야 한다.
 */
export function mergeWithinColumn(boxes: ProblemBox[]): ProblemBox[] {
  if (boxes.length < 2) return boxes;
  const columns = new Map<number, ProblemBox>();
  for (const b of boxes) {
    const col = columnOf(b);
    const cur = columns.get(col);
    if (!cur) {
      columns.set(col, b);
      continue;
    }
    const x = Math.min(cur.x, b.x);
    const y = Math.min(cur.y, b.y);
    const right = Math.max(cur.x + cur.w, b.x + b.w);
    const bottom = Math.max(cur.y + cur.h, b.y + b.h);
    columns.set(col, { x, y, w: right - x, h: bottom - y });
  }
  return [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}
