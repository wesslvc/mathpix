import {
  blockToHtml,
  renderMathTextWithInfo,
  type BoxOverride,
  type RenderedBlock,
} from "./renderMathText";
import { diagramStyleCss, type DiagramLayout } from "./diagramLayout";

/** 카드에 붙는 그림 하나가 어디에 어떤 크기로 놓이는지. */
export type CardFigure = {
  id: string;
  /** `<img>`나 `<svg>` 마크업. 비어 있으면 끼우지 않는다. */
  markup: string;
  layout: DiagramLayout;
  /** anchors 배열의 인덱스. 범위를 벗어나면 맨 아래로 본다. */
  position: number;
};

/**
 * 그림을 놓을 수 있는 자리들. 위에서부터 순서대로다.
 *
 * 문단 사이뿐 아니라 **조건 박스·보기 박스 안의 줄 사이**도 자리가 된다.
 * line이 null이면 그 블록 앞(박스라면 테두리 바깥), 숫자면 박스 안 그 줄
 * 앞이다(lines.length면 박스 안 맨 끝).
 */
export function buildAnchors(
  blocks: RenderedBlock[],
): { block: number; line: number | null }[] {
  const out: { block: number; line: number | null }[] = [];
  blocks.forEach((b, bi) => {
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
 * 본문과 그림을 한 덩어리 HTML로 조립한다.
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

  const atSlot = (slot: number) =>
    figures
      .filter(
        (f) =>
          typeof f.markup === "string" &&
          f.markup.length > 0 &&
          clamp(f.position) === slot,
      )
      .map(
        (f) =>
          `<div class="problem-figure" data-fig-id="${f.id}" style="${diagramStyleCss(
            f.layout,
          )}">${f.markup}</div>`,
      )
      .join("");

  let slot = 0;
  let out = "";
  for (const block of blocks) {
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
  return buildCardHtml(blocks, spec.figures);
}

export { blockToHtml };
