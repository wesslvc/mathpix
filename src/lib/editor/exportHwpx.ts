import { HWPXBuilder, write, type StyledSegment } from "hwpx-js";
import { plainMath } from "@/lib/kice/solutionLayout";
import { BOGI_LABELS, CIRCLED, pointsLabel, type QDoc } from "./doc";
import { blockHtml, SERIF, type Block } from "./blocks";
import { inlineHtml, LETTER, showPoints } from "./render";

/**
 * **한글(HWPX) 파일로 내보내기**(hwpx-js, Apache-2.0). A4 · 두 단 · 명조.
 *
 * 한계(첫 버전): 수식은 한글 수식 개체가 아니라 **읽을 수 있는 글자**로 넣는다(√, 분수는 (a)/(b)).
 * 그림은 SVG 를 PNG 로 바꿔 넣는다. <보기> 상자는 표로 넣는다.
 */
/** 한글에 함께 깔리는 실제 평가원 글꼴(2028 예시문항이 쓴 것). */
const FONT = "HY신명조";
const GOTHIC_FONT = "HY중고딕";
const SIZE = 10;
const COL_MM = (210 - 15 * 2 - 8) / 2; // 단 폭

function segments(src: string, base: StyledSegment["style"] = {}): StyledSegment[] {
  const out: StyledSegment[] = [];
  const re = /(\$[^$]+\$|\*\*.+?\*\*|__.+?__)/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push({ text: src.slice(last, m.index), style: { ...base } });
    const t = m[0];
    if (t.startsWith("$")) out.push({ text: plainMath(t.slice(1, -1)), style: { ...base, italic: true } });
    else if (t.startsWith("**")) out.push({ text: t.slice(2, -2), style: { ...base, bold: true } });
    else out.push({ text: t.slice(2, -2), style: { ...base, underline: true } });
    last = m.index! + t.length;
  }
  if (last < src.length) out.push({ text: src.slice(last), style: { ...base } });
  return out.map((s) => ({ ...s, style: { fontName: FONT, fontSize: SIZE, ...s.style } }));
}

const paras = (src: string) => src.split(/\n\s*\n/).map((s) => s.trim().replace(/\n/g, " ")).filter(Boolean);
const flat = (src: string) => segments(src).map((s) => s.text).join("");

/** SVG → PNG(브라우저). 폭 px 와 비율을 함께 돌려준다. */
export async function svgToPng(svg: string, widthPx = 1200): Promise<{ png: Uint8Array; ratio: number } | null> {
  try {
    const blob = new Blob([svg.includes("xmlns=") ? svg : svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("svg"));
      img.src = url;
    });
    const vb = /viewBox\s*=\s*"[\d.\-\s]+?\s([\d.]+)\s+([\d.]+)"/.exec(svg);
    const ratio = vb ? Number(vb[2]) / Number(vb[1]) : img.naturalHeight / Math.max(1, img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = widthPx;
    c.height = Math.max(1, Math.round(widthPx * ratio));
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const b64 = c.toDataURL("image/png").split(",")[1];
    return { png: Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), ratio };
  } catch {
    return null;
  }
}

/**
 * 자료 블록 넣기: 글·대화·단순한 표는 한글 개체로(고칠 수 있게), 상자·그래프·말풍선·나란히 같은 나머지는
 * 미리보기와 같은 모양을 **그림으로 찍어** 넣는다(한글에서 모양이 어긋나지 않게).
 */
async function addBlock(b: HWPXBuilder, blk: Block) {
  if (blk.kind === "text") {
    const base = { ...(blk.bold ? { bold: true } : {}), ...(blk.font === "gothic" ? { fontName: GOTHIC_FONT } : {}) };
    for (const p of paras(blk.text)) b.addStyledText(segments(p, base));
    return;
  }
  if (blk.kind === "dialog") {
    for (const l of blk.lines) b.addStyledText([...segments(`${l.who}${l.who ? ": " : ""}`, { bold: true }), ...segments(l.text)]);
    return;
  }
  if (blk.kind === "table" && !blk.rows.some((r) => r.some((c) => c === "<" || c === "^" || c.startsWith("[img:")))) {
    b.addTable(
      blk.rows.map((r) => r.map(flat)),
      { borderStyle: "SOLID", width: (COL_MM * (blk.widthPct ?? 100)) / 100, headerRow: (blk.header ?? 0) > 0 },
    );
    return;
  }
  const { captureHtml } = await import("./exportPdf");
  const W = 400;
  const html = `<div style="font-family:${SERIF};font-size:15px;line-height:1.75;letter-spacing:${LETTER};color:#111;background:#fff;padding:2px">${blockHtml(blk, inlineHtml)}</div>`;
  const png = await captureHtml(html, W);
  const size = await pngSize(png);
  const w = COL_MM;
  b.addImage(png, "png", { width: w, height: (w * size.h) / Math.max(1, size.w) });
}

async function pngSize(png: Uint8Array): Promise<{ w: number; h: number }> {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

export async function docsToHwpx(docs: QDoc[], withSolutions = false): Promise<Uint8Array> {
  const b = new HWPXBuilder()
    .setPageSettings({ width: 210, height: 297, marginLeft: 15, marginRight: 15, marginTop: 18, marginBottom: 15 })
    .setColumns({ count: 2, gap: 8 });
  for (const doc of docs) {
    const stem = paras(doc.stem);
    const first = stem.shift() ?? "";
    b.addStyledText([{ text: `${doc.number}. `, style: { fontName: FONT, fontSize: SIZE + 1, bold: true } }, ...segments(first)]);
    for (const p of stem) b.addStyledText(segments(p));
    if (doc.figure) {
      const r = await svgToPng(doc.figure.svg);
      if (r) {
        const w = (COL_MM * doc.figure.widthPct) / 100;
        b.addImage(r.png, "png", { width: w, height: w * r.ratio });
      }
      if (doc.figure.caption) b.addStyledText(segments(doc.figure.caption));
    }
    for (const blk of doc.blocks ?? []) await addBlock(b, blk);
    if (doc.question.trim()) b.addStyledText(segments(`${doc.question.trim()}${showPoints(doc) ? ` [${pointsLabel(doc.points)}]` : ""}`));
    const bogi = doc.bogi.filter((x) => x.trim());
    if (bogi.length) {
      b.addTable([["<보 기>"], ...bogi.map((x, i) => [`${BOGI_LABELS[i]}. ${flat(x)}`])], { borderStyle: "SOLID", width: COL_MM, headerRow: true });
    }
    if (doc.choiceTable?.header.length) {
      const t = doc.choiceTable;
      b.addTable([["", ...t.header.map(flat)], ...t.rows.map((r, i) => [CIRCLED[i], ...r.map(flat)])], { borderStyle: "NONE", width: COL_MM });
    } else if (doc.choices.some((c) => c.trim())) {
      b.addParagraph(doc.choices.map((c, i) => `${CIRCLED[i]} ${flat(c)}`).join("    "), { fontName: FONT, fontSize: SIZE });
    }
    b.addEmptyParagraph();
  }
  if (withSolutions && docs.some((d) => d.solution.trim())) {
    b.addSection();
    b.addParagraph("정답과 해설", { fontName: FONT, fontSize: 14, bold: true });
    for (const d of docs) {
      b.addParagraph(`${d.number}. 정답 ${d.answer ? CIRCLED[d.answer - 1] : "-"}`, { fontName: FONT, fontSize: SIZE, bold: true });
      for (const p of paras(d.solution)) b.addStyledText(segments(p));
      b.addEmptyParagraph();
    }
  }
  return write(b.build());
}

/** 검수용: 그림 SVG 를 PNG data URL 로. */
export async function svgToPngDataUrl(svg: string): Promise<string | null> {
  const r = await svgToPng(svg, 1000);
  if (!r) return null;
  let bin = "";
  for (let i = 0; i < r.png.length; i += 0x8000) bin += String.fromCharCode(...r.png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
