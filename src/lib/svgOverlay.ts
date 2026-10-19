import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import fontkit from "@pdf-lib/fontkit";

/**
 * **sol 이 설계한 SVG 덮개를 서버에서 그려 그림 위에 덮는다**(2026-10-19, 사용자 — "2차부터는 sol이 부분적으로 svg생성시 더 이득일 부분만 생성해서 덮어").
 *
 * 그림 편집 모델은 점·선·띠·이름표를 정확한 좌표에 못 놓는다. sol 은 계산한 값 그대로 도형을 쓸 수 있으므로, 그림 한 곳(네모)을 통째로
 * SVG 로 다시 그려 그 자리에 덮는다. 나머지는 지금 그림의 픽셀 그대로다.
 *
 * - 도형(`shapes`)은 `<text>` 없는 SVG 조각이다. **글자(`labels`)는 서버가 글꼴 윤곽을 경로로 바꿔 넣는다** — 서버리스에는 한글 글꼴이 없어
 *   `<text>` 로 두면 네모(□)로 그려진다. 글꼴은 `public/fonts/solution-serif.ttf`(나눔명조 한글 2350자 + 라틴·숫자·기호 일부).
 * - 이 SVG 는 모델이 쓴 것이라 위험한 요소는 거부한다(script·image·use·foreignObject·style·text).
 */

type Glyph = { id?: number; path: { toSVG: () => string } };
type Layout = { glyphs: Glyph[]; positions: { xAdvance: number; xOffset: number; yOffset: number }[] };
type Font = { unitsPerEm: number; layout: (t: string) => Layout };

let fontPromise: Promise<Font> | null = null;
function loadFont(): Promise<Font> {
  if (!fontPromise) {
    fontPromise = (async () => {
      const file = path.join(process.cwd(), "public", "fonts", "solution-serif.ttf");
      const bytes = new Uint8Array(await fs.promises.readFile(file));
      return (fontkit as unknown as { create: (b: Uint8Array) => unknown }).create(bytes) as Font;
    })();
    fontPromise.catch(() => {
      fontPromise = null;
    });
  }
  return fontPromise;
}

export type Overlay = {
  /** 덮을 네모 — 그림 크기 대비 0~1 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 좌표계(viewBox) 크기 — 네모의 픽셀 가로세로비와 같게 쓰라고 시킨다. */
  vw: number;
  vh: number;
  bg: string;
  shapes: string;
  labels: { t: string; x: number; y: number; size: number; anchor: "start" | "middle" | "end"; fill: string }[];
  note: string;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const color = (v: unknown, dflt: string) => (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : dflt);
const BAD = /<\s*(script|foreignObject|image|iframe|use|text|style|a)\b/i;

/** sol 이 낸 `overlays` 배열을 검증해 받는다. 이상한 항목은 버리고 버린 이유를 센다. */
export function parseOverlays(raw: unknown): { overlays: Overlay[]; dropped: string[] } {
  const overlays: Overlay[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { overlays, dropped };
  for (const [i, o] of raw.slice(0, 8).entries()) {
    const r = (o ?? {}) as Record<string, unknown>;
    const x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
    if (x === null || y === null || w === null || h === null || w < 0.02 || h < 0.02 || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) {
      dropped.push(`${i + 1}번 덮개: 네모(x,y,w,h)가 올바르지 않아요.`);
      continue;
    }
    if (w * h > 0.75) {
      dropped.push(`${i + 1}번 덮개: 그림의 대부분을 덮어 거절했어요.`);
      continue;
    }
    let shapes = typeof r.shapes === "string" ? r.shapes : "";
    if (shapes.length > 60_000 || BAD.test(shapes)) {
      dropped.push(`${i + 1}번 덮개: 도형 SVG 에 쓸 수 없는 요소가 있어요.`);
      continue;
    }
    shapes = shapes.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/(href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    const vw = num(r.vw) ?? 1000;
    const vh = num(r.vh) ?? 1000;
    if (vw < 10 || vh < 10 || vw > 5000 || vh > 5000) {
      dropped.push(`${i + 1}번 덮개: 좌표계 크기가 올바르지 않아요.`);
      continue;
    }
    const labels: Overlay["labels"] = [];
    if (Array.isArray(r.labels)) {
      for (const l of r.labels.slice(0, 60)) {
        const lr = (l ?? {}) as Record<string, unknown>;
        const t = typeof lr.t === "string" ? lr.t.slice(0, 40) : "";
        const lx = num(lr.x), ly = num(lr.y), size = num(lr.size);
        if (!t || lx === null || ly === null || size === null || size < 4 || size > 400) continue;
        const a = lr.anchor === "middle" || lr.anchor === "end" ? lr.anchor : "start";
        labels.push({ t, x: lx, y: ly, size, anchor: a, fill: color(lr.fill, "#000000") });
      }
    }
    overlays.push({ x, y, w, h, vw, vh, bg: color(r.bg, "#ffffff"), shapes, labels, note: typeof r.note === "string" ? r.note.slice(0, 160) : "" });
  }
  return { overlays, dropped };
}

/** 글자를 경로로. 글꼴에 없는 글자는 건너뛰고 알린다. */
async function labelPaths(labels: Overlay["labels"], missing: Set<string>): Promise<string> {
  if (!labels.length) return "";
  const font = await loadFont();
  const out: string[] = [];
  for (const lb of labels) {
    const l = font.layout(lb.t);
    const k = lb.size / font.unitsPerEm;
    const total = l.positions.reduce((a, p) => a + p.xAdvance, 0) * k;
    let pen = lb.anchor === "middle" ? lb.x - total / 2 : lb.anchor === "end" ? lb.x - total : lb.x;
    const chars = [...lb.t];
    l.glyphs.forEach((g, i) => {
      const pos = l.positions[i];
      if (g.id === 0) {
        missing.add(chars[i] ?? "?");
      } else {
        const d = g.path.toSVG();
        if (d) out.push(`<path fill="${lb.fill}" transform="translate(${(pen + pos.xOffset * k).toFixed(2)} ${(lb.y - pos.yOffset * k).toFixed(2)}) scale(${k.toFixed(5)} ${(-k).toFixed(5)})" d="${d}"/>`);
      }
      pen += pos.xAdvance * k;
    });
  }
  return out.join("");
}

export type OverlayResult = { bytes: Buffer; mime: "image/jpeg"; applied: number; missingGlyphs: string[]; failed: string[] };

/** 덮개들을 그려 그림 위에 얹은 JPEG 를 돌려준다. 하나도 못 그리면 null. */
export async function applyOverlays(baseBytes: Buffer, overlays: Overlay[]): Promise<OverlayResult | null> {
  const meta = await sharp(baseBytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H || !overlays.length) return null;
  const missing = new Set<string>();
  const failed: string[] = [];
  const layers: sharp.OverlayOptions[] = [];
  for (const [i, o] of overlays.entries()) {
    try {
      const left = Math.max(0, Math.round(o.x * W));
      const top = Math.max(0, Math.round(o.y * H));
      const pw = Math.max(4, Math.min(W - left, Math.round(o.w * W)));
      const ph = Math.max(4, Math.min(H - top, Math.round(o.h * H)));
      const labels = await labelPaths(o.labels, missing);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${o.vw} ${o.vh}" preserveAspectRatio="none">` +
        `<rect x="0" y="0" width="${o.vw}" height="${o.vh}" fill="${o.bg}"/>${o.shapes}${labels}</svg>`;
      const png = await sharp(Buffer.from(svg)).resize(pw, ph, { fit: "fill" }).png().toBuffer();
      layers.push({ input: png, left, top });
    } catch (err) {
      failed.push(`${i + 1}번 덮개: ${err instanceof Error ? err.message.slice(0, 80) : "그리지 못했어요"}`);
    }
  }
  if (!layers.length) return null;
  const bytes = await sharp(baseBytes).removeAlpha().composite(layers).jpeg({ quality: 92 }).toBuffer();
  return { bytes, mime: "image/jpeg", applied: layers.length, missingGlyphs: [...missing], failed };
}

/** sol 에게 줄 프롬프트 — 1차 그림 수정으로도 안 고쳐진 곳만 SVG 로 덮어 그리게 한다. */
export const OVERLAY_PROMPT = (hasOrig: boolean) =>
  `task: you are fixing a GENERATED VARIANT of a Korean exam question picture. ${hasOrig ? "image 1 = the ORIGINAL question (reference), image 2 = the CURRENT VARIANT picture." : "the image = the CURRENT VARIANT picture."} a checker listed the problems that remain after an image-edit pass (after the images, with the variant's REGISTERED ANSWER, its SOLUTION and the image size). the registered answer and the solution are the TRUTH — never change the answer. your job: for each problem decide where redrawing a small region as SVG is MORE RELIABLE than an image editor (precisely placed points/lines/bands/curves/ticks/labels computed from the solution's numbers; a table or a figure whose numbers must match exactly). skip problems an image editor handles fine and problems you cannot fix without changing the answer.
for each region output ONE overlay that REPLACES that rectangle of the picture entirely — so the rectangle must contain the whole thing you redraw (the full figure/graph/table incl. its axes, ticks and labels, with a little white margin) and you must redraw EVERYTHING inside it; choose it so it does not cut through unrelated text or choices. rectangle x,y,w,h = fractions (0–1) of the IMAGE width/height, measured carefully from the picture (use landmarks); keep it tight (never above 60% of the image).
coordinates inside an overlay use your own viewBox "0 0 vw vh": set vw:vh EQUAL to the rectangle's real pixel ratio ((w × imageWidth) : (h × imageHeight)), e.g. vw = 1000. "shapes" = SVG markup WITHOUT <svg> and WITHOUT any <text>: only <g> <path> <line> <polyline> <polygon> <rect> <circle> <ellipse> with fill/stroke attributes; match the original style (black/white/gray, stroke 1.5–3 in viewBox units scaled to the picture, same line types: dashed via stroke-dasharray). ALL text goes in "labels" (we convert glyphs to paths): {"t":"글자","x":..,"y":.. baseline start/anchor point in viewBox units,"size":font size in viewBox units matching the picture's text height,"anchor":"start|middle|end","fill":"#000"}; use only Hangul, digits, Latin letters and common signs (no √ ≤ ≥ ≠ π ∠ △ → — write them as words or draw them as shapes). markers like ●/○/▲ are shapes. compute every position from the solution's values with one consistent scale; legends, axes and tick labels as in the current picture.
you may ALSO return "solution" ONLY if the solution text itself contains a calculation error or contradicts the registered answer (never change the answer); otherwise null.
reply ONLY JSON: {"overlays":[{"note":"한국어 한 줄: 무엇을 왜 덮어 그리나","x":0.1,"y":0.2,"w":0.4,"h":0.3,"vw":1000,"vh":750,"bg":"#ffffff","shapes":"<g>…</g>","labels":[{"t":"P","x":120,"y":80,"size":36,"anchor":"middle","fill":"#000000"}]}],"solution":null,"skipped":"덮지 않은 문제와 이유(한국어, 없으면 빈 문자열)"}. empty overlays if nothing should be redrawn.`;
