import { collectTables, type CardFigure } from "./cardHtml";
import {
  DEFAULT_DIAGRAM_LAYOUT,
  DEFAULT_TABLE_LAYOUT,
  type DiagramLayout,
} from "./diagramLayout";
import type { BoxRange, RenderedBlock } from "./renderMathText";

/**
 * 저장되는 그림 한 개.
 *
 * **저장 위치가 `problems.box_range`인 이유**: 새 컬럼을 만들려면 마이그레이션이
 * 필요한데, 안 돌린 사람에게는 저장 자체가 실패한다(없는 컬럼에 쓰면 에러).
 * 글자 크기(fontPt)를 같은 이유로 거기 얹었다 — `src/lib/fontSize.ts` 참고.
 *
 * 이걸 저장하기 전에는 **수정하면 그림이 사라졌다.** 저장되는 건 이미 합쳐진
 * PNG 한 장과 본문뿐이었고, 수정 화면은 본문으로 카드를 다시 그리기 때문에
 * 그림이 없는 카드가 만들어져 그대로 덮어써졌다.
 */
export type StoredFigure = {
  id: string;
  /**
   * `<img>`/`<svg>` 마크업.
   *
   * **표는 저장하지 않는다** — 표는 본문에서 다시 만들어지므로(collectTables)
   * 같이 저장하면 본문을 고쳤을 때 저장본이 낡은 표를 들고 있게 된다.
   * 표는 사용자가 옮겨둔 자리·크기만 저장한다.
   */
  markup?: string;
  layout: DiagramLayout;
  position: number;
  kind?: "figure" | "table";
  row?: boolean;
  /** AI 가 다시 그린 그림인가. 수정 화면에서 다시 그리기를 막는 데 쓴다. */
  ai?: boolean;
  /**
   * **AI 가 갈아치우기 전의 마크업.** 사람이 오려낸 그 픽셀이다.
   *
   * 예전에는 AI 결과가 `markup` 을 통째로 덮어써서 원본이 어디에도 안 남았다.
   * 그러면 되돌릴 수도, 다른 지시로 다시 그릴 수도 없다(입력으로 쓸 원본이
   * 없으니까). 그래서 따로 들고 있는다.
   *
   * **한 번 담기면 덮지 않는다** — 두 번째 AI 결과가 첫 번째 AI 결과를 원본으로
   * 만들어 버리면 안 된다. 원본은 언제나 사람이 오려낸 그 그림이다.
   *
   * AI 를 돌린 그림에만 생긴다(그만큼 저장 용량이 는다). 표에는 없다.
   */
  origin?: string;
};

/** 카드에 붙은 것들을 저장할 형태로. 표에서는 마크업을 뗀다. */
export function toStoredFigures(figures: CardFigure[]): StoredFigure[] {
  return figures.map((f) => ({
    id: f.id,
    ...(f.kind === "table" ? {} : { markup: f.markup }),
    layout: f.layout,
    position: f.position,
    kind: f.kind,
    row: f.row,
    ...(f.ai ? { ai: true } : {}),
    ...(f.kind !== "table" && f.origin ? { origin: f.origin } : {}),
  }));
}

function isLayout(v: unknown): v is DiagramLayout {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    Number.isFinite(l.scale) &&
    Number.isFinite(l.offsetX) &&
    Number.isFinite(l.offsetY)
  );
}

/**
 * 저장된 마크업으로 쓸 만한 값인가.
 *
 * 이 문자열은 카드에 그대로 이어붙여진다(dangerouslySetInnerHTML). RLS로 자기
 * 행만 읽고 쓰지만, 값이 깨져 있으면 "undefined"가 문제에 인쇄되거나 엉뚱한
 * 마크업이 섞이므로 모양을 확인하고 받는다.
 */
function isFigureMarkup(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\s*<(img|svg)[\s>]/i.test(v) &&
    !/<\s*script/i.test(v)
  );
}

/** 저장된 box_range 값에서 그림 목록을 읽는다. 값이 이상하면 조용히 버린다. */
export function readStoredFigures(boxRange: unknown): StoredFigure[] {
  if (!boxRange || typeof boxRange !== "object") return [];
  const raw = (boxRange as { figures?: unknown }).figures;
  if (!Array.isArray(raw)) return [];

  const out: StoredFigure[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.id !== "string" || !isLayout(f.layout)) continue;
    if (!Number.isInteger(f.position)) continue;
    const kind = f.kind === "table" ? "table" : "figure";
    // 표가 아닌데 마크업이 쓸 수 없으면 그릴 게 없으므로 버린다.
    if (kind !== "table" && !isFigureMarkup(f.markup)) continue;
    out.push({
      id: f.id,
      markup: kind === "table" ? undefined : (f.markup as string),
      layout: f.layout,
      position: f.position as number,
      kind,
      row: f.row === true,
      ai: f.ai === true,
      // 원본도 카드에 그대로 붙을 수 있는 값이라 마크업과 같은 검사를 거친다.
      origin: isFigureMarkup(f.origin) ? (f.origin as string) : undefined,
    });
  }
  return out;
}

/**
 * 저장된 값과 지금 본문을 합쳐 카드에 붙일 목록을 만든다.
 *
 * 표는 본문에서 새로 뽑고(그래야 본문을 고치면 표도 따라 바뀐다) 저장돼 있던
 * 자리·크기만 입힌다. 순서는 ResultStage와 같게 표를 먼저 둔다 — 같은 자리에서
 * 나란히 놓일 때 왼쪽에 오는 기본값이 화면마다 달라지면 안 된다.
 */
export function restoreCardFigures(
  stored: StoredFigure[],
  blocks: RenderedBlock[],
): CardFigure[] {
  const byId = new Map(stored.map((s) => [s.id, s]));

  const tables: CardFigure[] = collectTables(blocks).map((t) => {
    const s = byId.get(t.id);
    return {
      id: t.id,
      markup: t.markup,
      layout: s?.layout ?? DEFAULT_TABLE_LAYOUT,
      position: s?.position ?? t.defaultPosition,
      kind: "table" as const,
      row: s?.row ?? false,
    };
  });

  const figures: CardFigure[] = stored
    .filter((s) => s.kind !== "table" && typeof s.markup === "string")
    .map((s) => ({
      id: s.id,
      markup: s.markup as string,
      layout: s.layout ?? DEFAULT_DIAGRAM_LAYOUT,
      position: s.position,
      kind: "figure" as const,
      row: s.row ?? false,
      ai: s.ai === true,
      origin: s.origin,
    }));

  return [...tables, ...figures];
}

/**
 * `problems.box_range`에 그대로 들어가는 값.
 *
 * 컬럼 이름이 실제 내용보다 좁지만, 새 컬럼을 만들면 마이그레이션을 안 돌린
 * 사람에게는 저장 자체가 실패한다. 안전을 택했다(fontSize.ts 주석 참고).
 * `ranges: null`이 "박스는 자동 감지"를 뜻한다.
 */
export type StoredBoxRange = {
  ranges: BoxRange[] | null;
  fontPt: number;
  figures?: StoredFigure[];
  /**
   * 사용자가 손으로 정해 둔 문제 번호(예: 15, 22, 28).
   *
   * 없으면 본문 맨 앞에서 뽑거나(`parseProblemNumber`) 그것도 없으면 차례대로
   * 1번부터 매긴다. 통째로 그린 문제는 본문이 없어서 손으로 적어야 한다.
   */
  number?: number | null;
};
