import type { RichBlock, RichRun } from "./richText";

/**
 * **조판기** — 지문 글자를 단에 흘려 넣는다.
 *
 * 사진을 앉히는 것과 달리 글자는 우리가 줄을 나눠야 한다. 단 하나가 차면
 * 다음 단으로, 쪽이 차면 다음 쪽으로 이어진다. **상자는 단이 넘어가면 잘리고
 * 다음 단에서 이어 그린다**(사용자 요청) — 실제 문제지가 그렇게 인쇄된다.
 *
 * **글꼴 폭을 재는 일은 밖에서 받는다**(`measure`). 이 파일이 pdf-lib 을 알면
 * 화면에서 미리보기를 그릴 수 없다 — 재는 방법만 갈아 끼우면 어디서든 쓴다.
 *
 * 한글 줄바꿈은 영어와 다르다. **글자 아무 데서나 끊어도 된다** — 다만 닫는
 * 문장부호가 줄 첫머리에 오거나 여는 부호가 줄 끝에 남으면 안 된다. 라틴
 * 낱말은 띄어쓰기에서 끊는다.
 */

/** 줄 첫머리에 올 수 없는 글자(닫는 부호·문장부호). */
const NO_LINE_START = "」』】〉》)]}）］｝.,;:!?%’”…·、。！？：；";
/** 줄 끝에 남을 수 없는 글자(여는 부호). */
const NO_LINE_END = "「『【〈《([{（［｛‘“";

const isLatin = (ch: string) => /[A-Za-z0-9]/.test(ch);

export type FlowStyle = {
  /** 본문 글자 크기(pt). */
  size: number;
  /** 줄 간격 배수. 수능 국어 지문은 1.5 언저리다. */
  lineHeight: number;
  /** 문단 사이 간격(pt). */
  paraGap: number;
  /** 상자 안쪽 여백(pt). */
  boxPad: number;
  /** 첫 줄 들여쓰기(pt). */
  indent: number;
};

export const DEFAULT_FLOW_STYLE: FlowStyle = {
  size: 9.8,
  lineHeight: 1.62,
  paraGap: 3.4,
  boxPad: 7,
  indent: 9.8,
};

/** 글자 폭을 재는 함수. `bold` 는 굵게 흉내(조금 넓다)를 반영한다. */
export type Measure = (text: string, size: number, bold: boolean) => number;

/** 한 줄에 놓인 토막 하나. `dx` 는 줄 왼쪽 끝에서의 거리. */
export type FlowPiece = { t: string; dx: number; w: number; b?: boolean; u?: boolean; sq?: boolean };

export type FlowItem =
  | { kind: "line"; x: number; y: number; size: number; pieces: FlowPiece[] }
  /**
   * 상자 테두리 한 도막. 단을 넘어가면 이어지는 쪽은 `top: false`,
   * 앞쪽은 `bottom: false` 라 **잘린 것처럼** 그려진다.
   */
  | { kind: "boxEdge"; x: number; y: number; w: number; h: number; top: boolean; bottom: boolean }
  | { kind: "figure"; id: string; x: number; y: number; w: number; h: number };

/** 글자를 흘려 넣을 자리 하나(단 하나). */
export type FlowColumn = { x: number; top: number; bottom: number; width: number };

/** 한 단에 놓인 것들. `column` 은 넘겨받은 배열에서의 자리. */
export type FlowResult = { column: number; items: FlowItem[] };

/** 줄 하나를 만들 재료. */
type Chunk = { t: string; b?: boolean; u?: boolean; sq?: boolean };

/**
 * 문단을 줄로 나눈다. **그리디로 채운다** — 남은 폭에 들어가는 만큼 넣고
 * 끊는다. 끊는 자리는 한글이면 아무 글자 사이, 라틴이면 띄어쓰기다.
 */
function breakRuns(
  runs: RichRun[],
  widths: number[],
  measure: Measure,
  size: number,
): Chunk[][] {
  const lines: Chunk[][] = [];
  let line: Chunk[] = [];
  let used = 0;
  let limit = widths[0] ?? 0;

  const push = () => {
    lines.push(line);
    line = [];
    used = 0;
    limit = widths[Math.min(lines.length, widths.length - 1)] ?? limit;
  };

  for (const run of runs) {
    let buf = "";
    const flush = () => {
      if (!buf) return;
      line.push({
        t: buf,
        ...(run.b ? { b: true } : {}),
        ...(run.u ? { u: true } : {}),
        ...(run.sq ? { sq: true } : {}),
      });
      used += measure(buf, size, run.b === true);
      buf = "";
    };

    const chars = [...run.t];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const w = measure(ch, size, run.b === true);
      const next = chars[i + 1] ?? "";
      if (used + measure(buf, size, run.b === true) + w > limit && (buf || line.length)) {
        // 닫는 부호는 줄 첫머리에 올 수 없다 — 한 글자 더 넣어 매달아 둔다.
        if (NO_LINE_START.includes(ch)) {
          buf += ch;
          flush();
          push();
          continue;
        }
        // 여는 부호가 줄 끝에 남지 않게 한 글자를 넘긴다.
        if (buf && NO_LINE_END.includes(buf[buf.length - 1])) {
          const held = buf[buf.length - 1];
          buf = buf.slice(0, -1);
          flush();
          push();
          buf = held + ch;
          continue;
        }
        // 라틴 낱말 한가운데면 띄어쓰기까지 되돌린다(낱말을 자르지 않는다).
        if (isLatin(ch) && buf && isLatin(buf[buf.length - 1])) {
          const at = buf.lastIndexOf(" ");
          if (at > 0) {
            const tail = buf.slice(at + 1);
            buf = buf.slice(0, at);
            flush();
            push();
            buf = tail + ch;
            continue;
          }
        }
        flush();
        push();
        buf = ch === " " ? "" : ch;
        continue;
      }
      buf += ch;
      void next;
    }
    flush();
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [[]];
}

/** 줄 하나를 자리로 바꾼다. */
function placeLine(
  chunks: Chunk[],
  x: number,
  y: number,
  size: number,
  measure: Measure,
  indent: number,
  center: number | null,
): FlowItem {
  const pieces: FlowPiece[] = [];
  let dx = indent;
  for (const c of chunks) {
    const w = measure(c.t, size, c.b === true);
    pieces.push({
      t: c.t,
      dx,
      w,
      ...(c.b ? { b: true } : {}),
      ...(c.u ? { u: true } : {}),
      ...(c.sq ? { sq: true } : {}),
    });
    dx += w;
  }
  if (center != null && dx < center) {
    const shift = (center - dx) / 2;
    for (const p of pieces) p.dx += shift;
  }
  return { kind: "line", x, y, size, pieces };
}

/**
 * 블록들을 단에 흘려 넣는다.
 *
 * 단이 모자라면 **넣을 수 있는 데까지만** 넣고 남은 것을 `rest` 로 돌려준다 —
 * 부르는 쪽이 다음 쪽의 단을 더 주고 다시 부르면 이어진다.
 */
export function flowBlocks(
  blocks: RichBlock[],
  columns: FlowColumn[],
  measure: Measure,
  style: FlowStyle = DEFAULT_FLOW_STYLE,
): { results: FlowResult[]; rest: RichBlock[] } {
  const results: FlowResult[] = columns.map((_, i) => ({ column: i, items: [] }));
  const step = style.size * style.lineHeight;

  let col = 0;
  let y = columns[0]?.top ?? 0;

  /**
   * 새 단 맨 위에서 띄울 여백. 상자 안을 흘리는 동안에는 `boxPad` 가 되어
   * 이어지는 도막의 글이 상자 위 테두리에 붙지 않는다(중첩 상자면 겹쳐 쌓인다).
   */
  let topPad = 0;

  /** 다음 단으로 넘어간다. 더 없으면 false. */
  const nextColumn = (): boolean => {
    col += 1;
    if (col >= columns.length) return false;
    y = columns[col].top + topPad;
    return true;
  };

  /**
   * 블록 하나를 흘린다. 다 못 넣으면 남은 부분을 돌려준다(상자는 잘린다).
   * `left`/`width` 는 상자 안쪽이면 그만큼 좁아진 자리다.
   */
  const run = (block: RichBlock, left: number, width: number): RichBlock | null => {
    // `left` 는 이 블록을 부를 때의 단(baseCol) 기준 자리다. 문단·그림이
    // 도중에 다음 단으로 넘어가면(`nextColumn()`) `col` 이 바뀌는데, 그때도
    // "그 단의 왼쪽 끝에서 원래 있던 만큼 들여써진 자리"를 지켜야 한다 —
    // 상자 안이면 `boxPad` 만큼, 아니면 0만큼. **이 상수(`inset`)를 한 번만
    // 재고 두고두고 `columns[col].x + inset` 으로 쓴다.**
    //
    // 예전에는 `columns[col].x + (left - columns[col].x)` 라고 적었는데, 이건
    // 대수적으로 그냥 `left` 다(`col` 이 상쇄된다) — 단이 바뀌어도 옛 단의
    // x 좌표를 그대로 썼다는 뜻이다. 두 단의 `top` 이 같아서 이어지는 줄이
    // 옛 단의 맨 위와 **같은 자리에 겹쳐 찍혔다**(실제로 그렇게 났다 —
    // 사용자가 캡처한 PDF에서 지문 도입부와 한참 뒤 문단이 같은 좌표에
    // 겹쳐 있었다). 그림과 상자 테두리도 같은 계산식을 썼어서 같은 값으로
    // 고쳤다.
    const baseCol = col;
    const inset = left - columns[baseCol].x;

    if (block.kind === "figure") {
      const h = width * block.ratio;
      if (y + h > columns[col].bottom && !(y === columns[col].top)) {
        if (!nextColumn()) return block;
      }
      results[col].items.push({ kind: "figure", id: block.id, x: columns[col].x + inset, y, w: width, h });
      y += h + style.paraGap;
      return null;
    }

    if (block.kind === "para") {
      const first = block.indent ? style.indent : 0;
      // 첫 줄만 들여쓰기라 줄마다 쓸 수 있는 폭이 다르다.
      const lines = breakRuns(
        block.runs,
        [width - first, width],
        measure,
        style.size,
      );
      for (let i = 0; i < lines.length; i++) {
        if (y + step > columns[col].bottom) {
          if (!nextColumn()) {
            // 남은 줄을 새 문단으로 돌려준다(들여쓰기는 이미 썼다).
            const restRuns: RichRun[] = lines.slice(i).flatMap((l) =>
              l.map((c) => ({
                t: c.t,
                ...(c.b ? { b: true } : {}),
                ...(c.u ? { u: true } : {}),
                ...(c.sq ? { sq: true } : {}),
              })),
            );
            return restRuns.length > 0 ? { kind: "para", runs: restRuns } : null;
          }
        }
        results[col].items.push(
          placeLine(
            lines[i],
            columns[col].x + inset,
            y,
            style.size,
            measure,
            i === 0 ? first : 0,
            block.center ? width : null,
          ),
        );
        y += step;
      }
      y += style.paraGap;
      return null;
    }

    // ── 상자 ──────────────────────────────────────────────────────
    // **단을 넘어가면 잘린다.** 앞쪽은 아래 테두리를 그리지 않고, 이어지는
    // 쪽은 위 테두리를 그리지 않는다 — 그래야 한 상자가 이어진 것으로 보인다.
    const innerWidth = width - style.boxPad * 2;
    let startY = y;
    let startCol = col;
    let openedTop = true;
    y += style.boxPad;

    const closeSegment = (bottom: boolean) => {
      results[startCol].items.push({
        kind: "boxEdge",
        x: columns[startCol].x + inset,
        y: startY,
        w: width,
        h: (bottom ? y + style.boxPad : columns[startCol].bottom) - startY,
        top: openedTop,
        bottom,
      });
    };

    const remaining: RichBlock[] = [...block.blocks];
    // 상자 안을 흘리는 동안에는 새 단 맨 위에도 `boxPad` 를 띄운다.
    // `finally` 로 되돌리는 이유 — 아래에 이른 반환(leftover)이 있어서
    // 한 자리에서만 복원하면 상자가 잘렸을 때 값이 새어 나간다.
    const prevTopPad = topPad;
    topPad = prevTopPad + style.boxPad;
    try {
      while (remaining.length > 0) {
        const before = col;
        // 안쪽 왼쪽 자리도 **매번 지금 단 기준으로** 다시 잰다 — 안 그러면
        // 상자 속 문단이 단을 넘을 때 같은 버그가 상자 안에서도 재현된다.
        const curLeft = columns[col].x + inset + style.boxPad;
        const leftover = run(remaining[0], curLeft, innerWidth);
        if (col !== before) {
          // 단이 바뀌었다 — 여기까지를 한 도막으로 닫고 새 도막을 연다.
          //
          // **`y` 는 절대 건드리지 않는다.** 예전에는 여기서
          // `y = startY + style.boxPad` 로 되돌렸는데, 그때는 방금 부른
          // `run()` 이 **이미 새 단에 줄을 놓고 그만큼 y 를 내려놓은
          // 뒤**다. 되돌리면 그 줄들 위에 다음 문단이 겹쳐 찍힌다 —
          // 새 단 첫 줄이 y=0, 다음 문단이 y=8(줄 간격은 22.4)에 그려져
          // 두세 줄이 서로 뭉개졌다. 사용자가 "단 넘어갈 때 찌그러진다"고
          // 한 것이 정확히 이것이다(캡처로 확인).
          //
          // 새 도막의 글이 위 테두리에 붙지 않게 하는 일은 `topPad` 가
          // 대신한다 — `nextColumn()` 이 처음부터 그만큼 내려서 시작한다.
          closeSegment(false);
          startCol = col;
          startY = columns[col].top;
          openedTop = false;
        }
        if (leftover) {
          // 자리가 아예 없어 못 넣었다. 남은 것을 상자째 돌려준다.
          closeSegment(false);
          return { kind: "box", blocks: [leftover, ...remaining.slice(1)] };
        }
        remaining.shift();
      }
    } finally {
      topPad = prevTopPad;
    }
    closeSegment(true);
    y += style.boxPad + style.paraGap;
    return null;
  };

  const rest: RichBlock[] = [];
  const queue = [...blocks];
  while (queue.length > 0) {
    if (col >= columns.length) break;
    const leftover = run(queue[0], columns[col].x, columns[col].width);
    if (leftover) {
      rest.push(leftover, ...queue.slice(1));
      break;
    }
    queue.shift();
  }
  if (queue.length > 0 && rest.length === 0) rest.push(...queue);

  return { results, rest };
}
