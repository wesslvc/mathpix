import { createClient } from "@/lib/supabase/client";
import { buildAnchors, type CardSpec } from "./cardHtml";
import { DEFAULT_DIAGRAM_LAYOUT } from "./diagramLayout";
import { persistFigureBlobs } from "./figureBlob";
import { ptToPx, readFontPt } from "./fontSize";
import { splitFigureMarkers } from "./problemCompare";
import { renderCardOffscreen } from "./renderCardOffscreen";
import { putBlob, removeBlobs } from "./blobClient";
import { figuresReference } from "./figureRefs";
import { restoreCardFigures, type StoredFigure } from "./storedFigures";

/**
 * **조판으로 고친 변형을 카드로 찍어 저장한다**(브라우저, 2026-10-19). 서버(`runTypesetFix`)가 `box_range.variantTypeset`
 * 에 글 + SVG 를 두고 `variantAuto.status = "rendering"` 으로 해 두면, 변형문제 화면이 이 함수로 카드 PNG 를 그려
 * `image_path`·본문·그림을 갈아 끼우고 재검수를 건다(카드 그리기는 html-to-image 라 브라우저가 있어야 한다).
 */
const BOTTOM = 9999;

export async function applyVariantTypeset(problemId: string): Promise<"saved" | "skip"> {
  const supabase = createClient();
  const { data: row, error } = await supabase.from("problems").select("image_path, box_range, text_content").eq("id", problemId).maybeSingle();
  if (error) throw error;
  const box = (row?.box_range ?? {}) as Record<string, unknown>;
  const auto = box.variantAuto as { status?: string; baseImagePath?: string } | undefined;
  const vt = box.variantTypeset as { text?: string; figures?: { id: string; svg: string }[] } | undefined;
  if (!row || auto?.status !== "rendering" || typeof vt?.text !== "string") return "skip";

  const { renderMathTextWithInfo } = await import("./renderMathText");
  const { text, markers } = splitFigureMarkers(vt.text);
  const posOf = new Map(markers.map((m) => [m.id, m.before.trim() ? buildAnchors(renderMathTextWithInfo(m.before).blocks).length - 1 : 0]));
  const figures: StoredFigure[] = (vt.figures ?? []).map((f) => ({
    id: crypto.randomUUID(),
    markup: f.svg,
    layout: { ...DEFAULT_DIAGRAM_LAYOUT, scale: 80 },
    position: posOf.get(f.id) ?? BOTTOM,
    kind: "figure",
    row: false,
  }));
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
  const { start: _s, end: _e, none: _n, variantTypeset: _vt, ...rest } = box;
  const nextBox = {
    ...rest,
    ranges: null,
    figures: persisted,
    ...(box.preTypeset ? {} : { preTypeset: { text: String(row.text_content ?? ""), figures: oldFigures } }),
    variantAuto: { ...(auto ?? {}), status: "rendered", at: new Date().toISOString() },
  };
  const { error: dbErr } = await supabase.from("problems").update({ image_path: newPath, text_content: text, latex: text, box_range: nextBox }).eq("id", problemId);
  if (dbErr) {
    await removeBlobs([newPath]);
    throw dbErr;
  }
  // 옛 카드는 지운다 — 처음 상태(통과할 때 지운다)이거나 그림이 가리키면 남긴다.
  if (oldPath && oldPath !== auto?.baseImagePath && !figuresReference(oldPath, oldFigures)) await removeBlobs([oldPath]);
  // 재검수를 건다(서버가 대기열에 넣는다).
  await fetch("/api/variant-auto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", ids: [problemId] }) });
  return "saved";
}
