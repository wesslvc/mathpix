import { toPng } from "html-to-image";
import { CARD_CAPTURE_OPTIONS, waitForImages } from "./layout";
import { renderMathTextWithInfo } from "./renderMathText";

/**
 * **해설 한 편을 그림(PNG)으로 그린다**(브라우저 전용). 해설은 Mathpix 형식(`$…$` LaTeX)으로 적혀 있어
 * 앱의 문제 카드와 같은 렌더러(KaTeX)로 그린다 — 글꼴에 없는 √ ≤ ≥ ≠ π ∠ △ → 도 모두 나온다.
 * 폭은 PDF 한 단(columnWidth pt)에 1:1 로 맞춘다: CSS 360px ↔ 한 단 폭, 글자는 9.2pt 쯤이 되도록 px 를 정했다.
 */
export const SOLUTION_CSS_WIDTH = 360;
const SOLUTION_FONT_PX = 10.4;

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

export async function renderSolutionPng(opts: { heading: string; text: string; title?: string }): Promise<Uint8Array> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;z-index:-1;pointer-events:none";
  const card = document.createElement("div");
  card.className = "problem-surface bg-white font-serif text-ink";
  card.style.width = `${SOLUTION_CSS_WIDTH}px`;
  card.style.padding = "2px 0 6px";
  card.style.fontSize = `${SOLUTION_FONT_PX}px`;
  card.style.lineHeight = "1.6";
  const body = renderMathTextWithInfo(opts.text).html;
  card.innerHTML =
    (opts.title ? `<p style="text-align:center;font-weight:700;font-size:1.25em;margin:0 0 8px">${esc(opts.title)}</p>` : "") +
    `<p style="font-weight:700;margin:0 0 3px">${esc(opts.heading)}</p>` +
    body;
  host.appendChild(card);
  document.body.appendChild(host);
  try {
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await waitForImages(card);
    const url = await toPng(card, CARD_CAPTURE_OPTIONS);
    const bin = atob(url.slice(url.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } finally {
    host.remove();
  }
}
