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
  for (const group of groupByColumn(boxes)) {
    // **단마다 따로 훑는다.** 앞 단의 마지막 것과 견주면 단을 넘어선 것끼리
    // 아울러 버린다 — 그러면 두 단을 통째로 감싸는 네모가 되어 사이의 여백까지
    // 딸려 온다(실제로 그렇게 됐다: 좌·우단을 합쳤더니 1104×1088 백지).
    const col: ProblemBox[] = [];
    for (const b of [...group].sort((a, b) => a.y - b.y)) {
      const last = col[col.length - 1];
      // 바로 앞 것과 **붙어 있을 때만** 아우른다(같은 단인 건 이미 보장됐다).
      if (last && b.y - (last.y + last.h) <= ADJACENT) {
        col[col.length - 1] = union(last, b);
      } else {
        col.push(b);
      }
    }
    out.push(...col);
  }
  return out;
}

/** 이만큼 가로로 겹치면 같은 단으로 본다(좁은 쪽 폭 대비). */
const SAME_COLUMN = 0.5;

/**
 * 고른 네모들을 **실제로 겹치는지** 보고 단으로 나눈다. 왼쪽 단이 먼저다.
 *
 * `columnOf`(가운데 0.5 로 가르기)를 쓰면 안 된다. 그건 두 단짜리 시험지에서
 * 조각이 확실히 한쪽에 몰려 있을 때 쓰는 기준이라, **한 단짜리 지면에서는
 * 통째로 틀린다.** 손으로 그린 네모는 좌우가 딱 대칭이 아니어서 가운데가
 * 0.5 를 아슬아슬하게 넘나드는데, 그러면 위 조각이 "오른쪽 단", 아래 조각이
 * "왼쪽 단"으로 갈리고 **왼쪽 단이 먼저**라는 규칙 때문에 아래가 위로 올라온다.
 * 실제로 그렇게 뒤집혔다(위 x 0.08~0.96 → 가운데 0.52, 아래 x 0.03~0.91 →
 * 가운데 0.47).
 *
 * 가로로 반 넘게 겹치면 같은 단이다 — 위아래로 놓인 것은 언제나 겹치고,
 * 나란히 놓인 두 단은 겹치지 않는다. 기준이 자리(0.5)가 아니라 조각들 사이의
 * 관계라서 한 단짜리든 두 단짜리든 그대로 맞는다.
 */
function groupByColumn(boxes: ProblemBox[]): ProblemBox[][] {
  const cols: { span: ProblemBox; items: ProblemBox[] }[] = [];
  for (const b of [...boxes].sort((p, q) => p.x - q.x)) {
    const hit = cols.find((c) => overlapRatio(c.span, b) >= SAME_COLUMN);
    if (hit) {
      hit.items.push(b);
      hit.span = union(hit.span, b);
    } else {
      cols.push({ span: b, items: [b] });
    }
  }
  return cols.sort((a, b) => a.span.x - b.span.x).map((c) => c.items);
}

/** 가로로 얼마나 겹치는가. 좁은 쪽 폭을 1 로 본다. */
function overlapRatio(a: ProblemBox, b: ProblemBox): number {
  const over = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (over <= 0) return 0;
  return over / Math.min(a.w, b.w);
}
