import { createClient } from "@/lib/supabase/client";
import { buildAnchors, type CardSpec } from "./cardHtml";
import { cropImageToDataUrl, loadImage } from "./cropImage";
import { DEFAULT_DIAGRAM_LAYOUT } from "./diagramLayout";
import { ensureDataUrl, rasterFromSvg, rasterToSvg } from "./figureImage";
import { persistFigureBlobs } from "./figureBlob";
import { ptToPx, readFontPt } from "./fontSize";
import { splitFigureMarkers, type TranscribedFigure } from "./problemCompare";
import { renderCardOffscreen } from "./renderCardOffscreen";
import { putBlob, removeBlobs } from "./blobClient";
import { thumbPathFor } from "./cardThumb";
import { figuresReference } from "./figureRefs";
import { readStoredFigures, restoreCardFigures, type StoredFigure } from "./storedFigures";

/**
 * **sol 조판 결과를 문제에 붙여 저장한다**(브라우저 쪽, 2026-10-02).
 *
 * 사용자 — "AI 통째로 그리기처럼 작동하게". 예전에는 수정 창이 결과를 받아 화면에만 얹고 저장을 눌러야 남았다 —
 * 창을 닫으면 결과가 버려졌다. 이제 sol 이 다 읽으면 **이 함수가 곧바로 문제 행에 저장한다.** 부르는 곳은
 * `FigureJobsProvider` 하나다(앱의 어느 화면이든 붙어 있다). 서버에서 끝났는데 아무 화면도 안 열려 있었으면
 * 다음에 앱을 열 때 저장한다 — 카드 PNG(`image_path`)는 html-to-image 라 브라우저가 있어야 해서다
 * (그림 하나 모드와 같은 사정). 그림 자리를 원본에서 오려 내는 일도 여기서 한다(서버에는 이미지를 여는 수단이 없다).
 *
 * 조판 전의 본문·그림은 `box_range.preTypeset` 에 남겨 둔다 — 수정 창의 "조판 전으로 되돌리기"가 그걸 쓴다.
 */

export type TypesetResult = { text?: string; figures?: TranscribedFigure[]; estKrw?: number };

/** 조판 전 상태. 되돌리기에 쓴다. */
export type PreTypeset = { text: string; figures: unknown[] };

/** 그림 자리를 놓을 "맨 아래". 카드 조립이 자리 목록 끝으로 붙인다(수정 창과 같은 값). */
const BOTTOM = 9999;

/** 이 문제가 조판할 수 있는 모양인가 — 본문이 비고 그림(표 제외)이 하나뿐. 그 그림의 원본 주소를 돌려준다. */
export function wholeFigureSource(text: string, figures: StoredFigure[]): string | null {
  const drawings = figures.filter((f) => f.kind !== "table");
  if (text.trim() !== "" || drawings.length !== 1) return null;
  const whole = drawings[0];
  return (whole.origin ? rasterFromSvg(whole.origin) : null) ?? (whole.markup ? rasterFromSvg(whole.markup) : null);
}

/** 옮겨 적은 글과 짚은 그림 자리로 본문·그림을 만든다. 그림은 `source`(원본)에서 오려 낸다. */
export async function buildTypesetMaterials(
  typed: TypesetResult,
  source: string,
): Promise<{ text: string; figures: StoredFigure[] }> {
  if (typeof typed.text !== "string") throw new Error("sol 이 옮겨 적지 못했어요.");
  const { renderMathTextWithInfo } = await import("./renderMathText");
  const { text, markers } = splitFigureMarkers(typed.text);
  // 그림 자리 = 그 그림 앞까지의 본문이 끝나는 자리(카드의 자리 목록 번호). 앞에 본문이 없으면 맨 위.
  const posOf = new Map(
    markers.map((m) => [
      m.id,
      m.before.trim() ? buildAnchors(renderMathTextWithInfo(m.before).blocks).length - 1 : 0,
    ]),
  );
  const figs = typed.figures ?? [];
  const figures: StoredFigure[] = [];
  if (figs.length) {
    const img = await loadImage(await ensureDataUrl(source));
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    for (const f of figs) {
      // 모델이 경계를 빠듯하게 잡는 일이 흔해 사방 1% 여유를 준다(그림 가장자리 눈금·글자가 잘리지 않게).
      const x0 = Math.max(0, f.x - 0.01);
      const y0 = Math.max(0, f.y - 0.01);
      const x1 = Math.min(1, f.x + f.w + 0.01);
      const y1 = Math.min(1, f.y + f.h + 0.01);
      const crop = cropImageToDataUrl(img, { x: x0 * W, y: y0 * H, width: (x1 - x0) * W, height: (y1 - y0) * H });
      figures.push({
        id: crypto.randomUUID(),
        markup: await rasterToSvg(crop),
        layout: DEFAULT_DIAGRAM_LAYOUT,
        // 본문에 자리 표시가 없는 그림은 맨 아래 — 미리보기에서 끌어 옮기면 된다.
        position: posOf.get(f.id) ?? BOTTOM,
        kind: "figure",
        row: false,
      });
    }
  }
  return { text, figures };
}

/**
 * 조판 결과를 문제 행에 저장한다. 본문·그림·카드 PNG 를 한 번에 갈아 끼운다.
 * 문제가 이미 조판할 모양이 아니면(그사이 본문을 저장했거나 그림을 바꿨다) 손대지 않고 `"stale"`.
 */
export async function persistTypeset(problemId: string, typed: TypesetResult): Promise<"saved" | "stale"> {
  const supabase = createClient();
  const { data: row, error } = await supabase
    .from("problems")
    .select("image_path, box_range, text_content")
    .eq("id", problemId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return "stale";
  const box = (row.box_range ?? {}) as Record<string, unknown>;
  const oldText = String(row.text_content ?? "");
  const stored = readStoredFigures(box);
  const source = wholeFigureSource(oldText, stored);
  if (!source) return "stale";

  const { text, figures } = await buildTypesetMaterials(typed, source);
  const { renderMathTextWithInfo } = await import("./renderMathText");
  const spec: CardSpec = {
    text,
    boxOverride: undefined,
    fontSizePx: ptToPx(readFontPt(box)),
    figures: restoreCardFigures(figures, renderMathTextWithInfo(text).blocks),
  };
  const dataUrl = await renderCardOffscreen(spec);
  const blob = await (await fetch(dataUrl)).blob();
  const oldPath = String(row.image_path ?? "");
  const dir = oldPath.split("/").slice(0, -1).join("/");
  const newPath = `${dir}/${crypto.randomUUID()}.png`;
  const up = await putBlob(supabase, newPath, blob, "image/png");
  if (!up.ok) throw new Error(up.error);
  const persisted = await persistFigureBlobs(supabase, dir, figures);

  const oldFigures = Array.isArray(box.figures) ? (box.figures as unknown[]) : [];
  // 박스 지정은 옛 본문의 줄 번호라 새 본문에는 맞지 않는다 — 자동 감지로 돌린다(옛 꼴 키도 함께 뗀다).
  const { start: _s, end: _e, none: _n, ...rest } = box;
  const nextBox = {
    ...rest,
    ranges: null,
    figures: persisted,
    preTypeset: { text: oldText, figures: oldFigures } satisfies PreTypeset,
  };
  const { error: dbErr } = await supabase
    .from("problems")
    .update({ image_path: newPath, text_content: text, latex: text, box_range: nextBox })
    .eq("id", problemId);
  if (dbErr) {
    await removeBlobs([newPath]);
    throw dbErr;
  }
  // 옛 카드는 지운다 — **다만 조판 전 그림이 그 파일을 가리키면 남긴다.** 통째로 다시 그린 문제는 그림의 마크업이
  // 곧 카드 파일이라(`persistWholeProblem`), 지우면 되돌리기가 빈 그림이 된다.
  if (oldPath && !figuresReference(oldPath, oldFigures)) await removeBlobs([oldPath, thumbPathFor(oldPath)]);
  return "saved";
}

/** 조판을 저장했다는 알림(수정 창·목록이 듣는다). */
export const TYPESET_APPLIED_EVENT = "typeset:applied";
export type TypesetAppliedDetail = { problemId: string; ok: boolean; error?: string };
