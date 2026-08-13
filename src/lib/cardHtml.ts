import {
  blockToHtml,
  renderMathTextWithInfo,
  type BoxOverride,
  type RenderedBlock,
} from "./renderMathText";
import {
  DEFAULT_TABLE_LAYOUT,
  diagramStyleCss,
  rowStyleCss,
  type DiagramLayout,
} from "./diagramLayout";

/**
 * 카드에 붙는 "옮길 수 있는 것" 하나가 어디에 어떤 크기로 놓이는지.
 *
 * 그림(도형·자료)과 **표**가 같은 취급을 받는다 — 사용자가 둘을 구분 없이
 * 끌어 옮기고, 같은 자리에 놓아 가로로 나란히 세울 수 있어야 해서다.
 */
export type CardFigure = {
  id: string;
  /** `<img>`/`<svg>`/`<table>` 마크업. 비어 있으면 끼우지 않는다. */
  markup: string;
  layout: DiagramLayout;
  /** anchors 배열의 인덱스. 범위를 벗어나면 맨 아래로 본다. */
  position: number;
  /** 표면 껍데기에 표 전용 여백 규칙을 걸어야 해서 종류를 구분한다. */
  kind?: "figure" | "table";
  /**
   * AI 가 다시 그린 그림인가.
   *
   * 수정 화면에서 **다시 그리기를 막는 데** 쓴다 — AI 결과를 또 AI 에 넣으면
   * 원본에서 멀어지기만 하고 요금만 두 번 나간다. 옛 데이터에는 이 값이
   * 없는데(구분할 방법도 없다) 그때는 막지 않는다.
   */
  ai?: boolean;
  /**
   * 같은 자리에 놓인 것끼리 가로로 나란히 놓는다. 혼자면 아무 효과가 없다
   * (나란히 세울 상대가 없으므로 평소처럼 한 줄을 차지한다).
   */
  row?: boolean;
};

/**
 * 그림·표를 놓을 수 있는 자리들. 위에서부터 순서대로다.
 *
 * 문단 사이뿐 아니라 **조건 박스·보기 박스 안의 줄 사이**도 자리가 된다.
 * line이 null이면 그 블록 앞(박스라면 테두리 바깥), 숫자면 박스 안 그 줄
 * 앞이다(lines.length면 박스 안 맨 끝).
 *
 * **표 블록은 자리를 만들지 않는다.** 표는 흐름에 박힌 문단이 아니라 옮길 수
 * 있는 물건이라, 자기 자리를 스스로 만들면 자기 뒤에 자기를 놓는 이상한 자리가
 * 생기고 화면의 DOM 순회(anchorPoints)와도 어긋난다.
 */
export function buildAnchors(
  blocks: RenderedBlock[],
): { block: number; line: number | null }[] {
  const out: { block: number; line: number | null }[] = [];
  blocks.forEach((b, bi) => {
    if (b.kind === "table") return;
    out.push({ block: bi, line: null });
    if (b.kind === "box") {
      for (let li = 0; li <= b.lines.length; li++) {
        out.push({ block: bi, line: li });
      }
    }
  });
  out.push({ block: blocks.length, line: null });
  return out;
}

/**
 * 본문에 들어 있는 표들을 "옮길 수 있는 것"으로 뽑아낸다.
 *
 * defaultPosition은 원문에서 표가 원래 있던 자리다 — 아무것도 안 건드리면
 * 예전과 똑같은 위치에 똑같이 그려진다. buildAnchors와 같은 순서로 훑어야
 * 자리 번호가 맞는다.
 */
export function collectTables(
  blocks: RenderedBlock[],
): { id: string; markup: string; defaultPosition: number }[] {
  const out: { id: string; markup: string; defaultPosition: number }[] = [];
  let slot = 0;
  for (const b of blocks) {
    if (b.kind === "table") {
      out.push({ id: b.id, markup: b.html, defaultPosition: slot });
      continue;
    }
    slot++;
    if (b.kind === "box") slot += b.lines.length + 1;
  }
  return out;
}

function itemHtml(f: CardFigure, inRow: boolean): string {
  const cls =
    f.kind === "table" ? "problem-figure problem-figure--table" : "problem-figure";
  return `<div class="${cls}" data-fig-id="${f.id}" style="${diagramStyleCss(
    f.layout,
    inRow,
  )}">${f.markup}</div>`;
}

/**
 * 본문과 그림·표를 한 덩어리 HTML로 조립한다.
 *
 * **buildAnchors와 정확히 같은 순서로 훑는다.** 하나라도 어긋나면 그림이
 * 엉뚱한 자리에 붙는다. 화면(ResultStage)과 뒤에서 도는 일꾼(FigureJobs)이
 * 같은 결과를 내야 해서 이 함수 하나만 쓴다 — 양쪽에 따로 구현하면 반드시
 * 어긋난다.
 */
export function buildCardHtml(
  blocks: RenderedBlock[],
  figures: CardFigure[],
): string {
  const anchorCount = buildAnchors(blocks).length;
  const clamp = (p: number) => Math.min(Math.max(p, 0), anchorCount - 1);

  const atSlot = (slot: number) => {
    const here = figures.filter(
      (f) =>
        typeof f.markup === "string" &&
        f.markup.length > 0 &&
        clamp(f.position) === slot,
    );
    if (here.length === 0) return "";
    // 나란히 놓기는 상대가 있어야 뜻이 있다. 혼자면 평소대로 한 줄을 쓴다.
    const inRow = here.length > 1 && here.some((f) => f.row);
    const ordered = inRow
      ? // 가로 순서는 "좌우" 값으로 정한다 — 미리보기에서 옆으로 끌면 그대로
        // 자리가 바뀐다. 값이 같으면 원래 순서를 지킨다(정렬이 흔들리지 않게).
        here
          .map((f, i) => ({ f, i }))
          .sort((a, b) =>
            a.f.layout.offsetX - b.f.layout.offsetX || a.i - b.i,
          )
          .map((x) => x.f)
      : here;
    const html = ordered.map((f) => itemHtml(f, inRow)).join("");
    return inRow
      ? `<div class="problem-figure-row" style="${rowStyleCss(
          ordered.map((f) => f.layout),
        )}">${html}</div>`
      : html;
  };

  let slot = 0;
  let out = "";
  for (const block of blocks) {
    // 표는 흐름에서 빼고 자기 자리(anchors)에 다시 끼워 넣는다.
    if (block.kind === "table") continue;
    out += atSlot(slot++);
    if (block.kind === "plain") {
      out += block.html;
      continue;
    }
    let inner = "";
    for (const line of block.lines) {
      inner += atSlot(slot++) + line;
    }
    inner += atSlot(slot++); // 박스 안 맨 끝
    out += `<div class="mmd-box">${inner}</div>`;
  }
  out += atSlot(slot);
  return out;
}

/** 문제 하나를 다시 그리는 데 필요한 전부. 화면이 닫혀도 이것만 있으면 된다. */
export type CardSpec = {
  text: string;
  boxOverride: BoxOverride | undefined;
  fontSizePx: number;
  figures: CardFigure[];
};

export function cardHtmlFromSpec(spec: CardSpec): string {
  const { blocks } = renderMathTextWithInfo(spec.text, spec.boxOverride);
  // 화면이 닫힌 뒤 다시 그릴 때 표가 빠지면 안 된다. 저장된 spec에 표가 없으면
  // (예전 형식) 원래 자리에 있는 그대로 넣어준다.
  const known = new Set(spec.figures.map((f) => f.id));
  const missing: CardFigure[] = collectTables(blocks)
    .filter((t) => !known.has(t.id))
    .map((t) => ({
      id: t.id,
      markup: t.markup,
      layout: DEFAULT_TABLE_LAYOUT,
      position: t.defaultPosition,
      kind: "table" as const,
    }));
  return buildCardHtml(blocks, [...missing, ...spec.figures]);
}

export { blockToHtml };
