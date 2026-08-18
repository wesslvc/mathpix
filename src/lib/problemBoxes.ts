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

/** 같은 단에서 이어진 조각으로 볼 세로 간격(지면 높이 대비). */
export const ADJACENT = 0.06;

/** 두 네모를 아우르는 네모. */
function union(a: ProblemBox, b: ProblemBox): ProblemBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

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
    columns.set(col, cur ? union(cur, b) : b);
  }
  return [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}

/**
 * **사용자가 손으로 고른** 조각들을 한 문제로 합칠 자리를 정한다.
 *
 * `mergeWithinColumn` 과 무엇이 다른가 — 그쪽은 "이미 한 문제로 판정된
 * 조각들"에 쓴다. 그것들은 서로 붙어 있는 게 보장돼 있어서(`ADJACENT` 로
 * 걸러 묶었다) 같은 단이면 통째로 아울러도 안전하다.
 *
 * 여기서는 그 보장이 없다. 사용자는 **아무거나** 고를 수 있고, 사이에 다른
 * 문제가 낀 둘을 고르는 일이 실제로 있다. 그때 통째로 아우르면 **사이의
 * 문제까지 딸려 들어와** 지면이 통째로 한 조각이 된다(그러면서 그 문제는
 * 목록에도 따로 남아 두 번 나온다). 실제로 그렇게 됐다.
 *
 * 그래서 같은 단이라도 **붙어 있는 것끼리만** 아우르고, 멀리 떨어진 것은
 * 따로 두어 나중에 세로로 이어 붙이게 한다. 이어 붙이기는 조각만 가져오므로
 * 사이에 있는 것을 절대 삼키지 않는다.
 *
 * 돌려주는 것은 읽는 차례다 — 왼쪽 단을 위에서 아래로, 그다음 오른쪽 단.
 */
export function mergeChosen(boxes: ProblemBox[]): ProblemBox[] {
  if (boxes.length < 2) return boxes;
  const out: ProblemBox[] = [];
  for (const col of [0, 1]) {
    const inCol = boxes
      .filter((b) => columnOf(b) === col)
      .sort((a, b) => a.y - b.y);
    for (const b of inCol) {
      const last = out[out.length - 1];
      // 바로 앞 것과 **같은 단이면서 붙어 있을 때만** 아우른다.
      if (last && columnOf(last) === col && b.y - (last.y + last.h) <= ADJACENT) {
        out[out.length - 1] = union(last, b);
      } else {
        out.push(b);
      }
    }
  }
  return out;
}
