import { getFontEmbedCSS, toPng } from "html-to-image";
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

// 글꼴 임베드 CSS 는 해설마다 똑같다 — toPng 가 호출마다 글꼴 파일을 전부 다시 받아 base64 로 바꾸면(수십 개면 몇 분) PDF 가
// 안 나온다. 첫 카드에서 한 번 만들어 다음 해설에 그대로 쓴다.
let fontCssPromise: Promise<string> | null = null;

/**
 * 수식 글꼴 CSS 를 **미리 한 번** 만들어 둔다(해설을 한 편씩 그리기 전에). 첫 해설이 글꼴 내려받기를 기다리다 시간 제한에
 * 걸려 연달아 실패하고 나머지가 `$…$` 글자 그대로 찍히던 문제를 막는다. 못 만들면(빈 값) 캐시하지 않아 다음에 다시 시도한다.
 */
export async function warmSolutionFonts(): Promise<void> {
  if (fontCssPromise) return;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;z-index:-1;pointer-events:none";
  const card = document.createElement("div");
  card.className = "problem-surface bg-white font-serif text-ink";
  card.innerHTML = renderMathTextWithInfo("$\\frac{a}{b}+\\sqrt{2}$ 가나다").html;
  host.appendChild(card);
  document.body.appendChild(host);
  try {
    const css = await Promise.race([getFontEmbedCSS(card), new Promise<string>((r) => setTimeout(() => r(""), 30_000))]).catch(() => "");
    if (css) fontCssPromise = Promise.resolve(css);
  } finally {
    host.remove();
  }
}

type SolOpts = { heading: string; text: string; title?: string; no?: string; source?: string; answer?: string };

function buildSolutionCard(opts: SolOpts): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "problem-surface bg-white font-serif text-ink";
  card.style.width = `${SOLUTION_CSS_WIDTH}px`;
  card.style.padding = "2px 0 6px";
  card.style.fontSize = `${SOLUTION_FONT_PX}px`;
  card.style.lineHeight = "1.6";
  const head =
    opts.no
      ? `<div style="display:flex;align-items:center;gap:8px;margin:${opts.title ? "0" : "4px"} 0 6px;padding-top:6px;border-top:1.5px solid #222">` +
        `<span style="font-size:2.1em;font-weight:800;line-height:1;letter-spacing:-0.02em">${esc(opts.no)}</span>` +
        `<span style="display:flex;flex-direction:column;gap:1px;min-width:0;flex:1">` +
        (opts.source ? `<span style="font-size:0.72em;color:#777;line-height:1.2;word-break:keep-all">${esc(opts.source)}</span>` : "") +
        `<span style="font-size:0.85em;font-weight:700;line-height:1.2">${opts.answer?.trim() ? `정답 ${esc(opts.answer.trim())}` : "&nbsp;"}</span>` +
        `</span></div>`
      : `<p style="font-weight:700;margin:0 0 3px">${esc(opts.heading)}</p>`;
  card.innerHTML =
    (opts.title ? `<p style="text-align:center;font-weight:700;font-size:1.25em;margin:0 0 10px">${esc(opts.title)}</p>` : "") +
    head +
    renderMathTextWithInfo(opts.text).html;
  return card;
}

const dataUrlToBytes = (url: string) => {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

/**
 * 해설 여러 편을 **묶어서 한 번에** 찍고 편별로 잘라 낸다(`renderSolutionPng` 를 편마다 부르면 편마다 DOM 복제·글꼴·SVG 변환이
 * 되풀이돼 몇십 편이면 몇 분이 걸린다). 묶음이 실패하면 그 묶음만 한 편씩 다시 찍는다. 편의 결과가 null 이면 못 만든 것이다.
 */
export async function renderSolutionPngs(
  list: SolOpts[],
  onProgress?: (done: number) => void,
  chunk = 16,
): Promise<(Uint8Array | null)[]> {
  const out: (Uint8Array | null)[] = new Array(list.length).fill(null);
  let done = 0;
  const starts: number[] = [];
  for (let a = 0; a < list.length; a += chunk) starts.push(a);
  const worker = async () => {
    for (let a = starts.shift(); a !== undefined; a = starts.shift()) {
    const part = list.slice(a, a + chunk);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;z-index:-1;pointer-events:none;background:#fff";
    const wrap = document.createElement("div");
    wrap.style.cssText = `width:${SOLUTION_CSS_WIDTH}px;background:#fff`;
    const cards = part.map((o) => buildSolutionCard(o));
    cards.forEach((c) => wrap.appendChild(c));
    host.appendChild(wrap);
    document.body.appendChild(host);
    try {
      if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await waitForImages(wrap);
      const fontEmbedCSS = fontCssPromise ? await fontCssPromise : "";
      const cap = fontEmbedCSS ? { ...CARD_CAPTURE_OPTIONS, fontEmbedCSS } : CARD_CAPTURE_OPTIONS;
      const ratio = CARD_CAPTURE_OPTIONS.pixelRatio;
      const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);
      if (webkit) await toPng(wrap, cap).catch(() => "");
      const url = await Promise.race([
        toPng(wrap, cap),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("묶음 캡처 시간 초과")), 60_000)),
      ]);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("묶음 그림을 읽지 못함"));
        img.src = url;
      });
      const wrapTop = wrap.getBoundingClientRect().top;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        const y = Math.round((r.top - wrapTop) * ratio);
        const h = Math.max(1, Math.round(r.height * ratio));
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = h;
        const ctx = cv.getContext("2d");
        if (!ctx) throw new Error("캔버스를 만들지 못함");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, cv.width, h);
        ctx.drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);
        out[a + i] = dataUrlToBytes(cv.toDataURL("image/png"));
      }
    } catch {
      // 이 묶음은 한 편씩 다시 찍는다.
      for (let i = 0; i < part.length; i++) {
        try {
          out[a + i] = await renderSolutionPng(part[i]);
        } catch {
          out[a + i] = null;
        }
      }
    } finally {
      host.remove();
    }
    done += part.length;
    onProgress?.(Math.min(list.length, done));
    }
  };
  // 묶음 둘을 동시에 찍는다(더 늘리면 아이패드에서 멈춘다).
  await Promise.all([worker(), worker()]);
  return out;
}

export async function renderSolutionPng(opts: { heading: string; text: string; title?: string; no?: string; source?: string; answer?: string }): Promise<Uint8Array> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;z-index:-1;pointer-events:none";
  const card = document.createElement("div");
  card.className = "problem-surface bg-white font-serif text-ink";
  card.style.width = `${SOLUTION_CSS_WIDTH}px`;
  card.style.padding = "2px 0 6px";
  card.style.fontSize = `${SOLUTION_FONT_PX}px`;
  card.style.lineHeight = "1.6";
  // 머리: 문제 번호를 크게(왼쪽 네모 딱지), 정답은 오른쪽에, 출처는 작고 옅게 번호 아래에. 번호를 못 가르면 예전 한 줄 머리.
  const head =
    opts.no
      ? `<div style="display:flex;align-items:center;gap:8px;margin:${opts.title ? "0" : "4px"} 0 6px;padding-top:6px;border-top:1.5px solid #222">` +
        `<span style="font-size:2.1em;font-weight:800;line-height:1;letter-spacing:-0.02em">${esc(opts.no)}</span>` +
        `<span style="display:flex;flex-direction:column;gap:1px;min-width:0;flex:1">` +
        (opts.source ? `<span style="font-size:0.72em;color:#777;line-height:1.2;word-break:keep-all">${esc(opts.source)}</span>` : "") +
        `<span style="font-size:0.85em;font-weight:700;line-height:1.2">${opts.answer?.trim() ? `정답 ${esc(opts.answer.trim())}` : "&nbsp;"}</span>` +
        `</span></div>`
      : `<p style="font-weight:700;margin:0 0 3px">${esc(opts.heading)}</p>`;
  card.innerHTML =
    (opts.title ? `<p style="text-align:center;font-weight:700;font-size:1.25em;margin:0 0 10px">${esc(opts.title)}</p>` : "") +
    head +
    renderMathTextWithInfo(opts.text).html;
  host.appendChild(card);
  document.body.appendChild(host);
  try {
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await waitForImages(card);
    // Safari(WebKit)는 첫 캡처가 비거나 던지는 일이 있어(글꼴·SVG foreignObject) 한 번 더 찍고, 실패하면 몇 번 다시 시도한다.
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);
    const fontEmbedCSS = fontCssPromise
      ? await fontCssPromise
      : await Promise.race([getFontEmbedCSS(card), new Promise<string>((r) => setTimeout(() => r(""), 40_000))]).catch(() => "");
    if (fontEmbedCSS && !fontCssPromise) fontCssPromise = Promise.resolve(fontEmbedCSS);
    let opts2 = fontEmbedCSS ? { ...CARD_CAPTURE_OPTIONS, fontEmbedCSS } : CARD_CAPTURE_OPTIONS;
    let url = "";
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3 && !url; attempt++) {
      try {
        if (webkit) await toPng(card, opts2).catch(() => "");
        url = await toPng(card, opts2);
      } catch (e) {
        lastErr = e;
        // 글꼴 임베드가 원인일 수 있어 다음 시도는 글꼴 CSS 없이(기본 옵션) 찍는다.
        opts2 = CARD_CAPTURE_OPTIONS;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!url) {
      throw new Error(`해설 그림 만들기 실패: ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? "알 수 없음")}`);
    }
    const bin = atob(url.slice(url.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } finally {
    host.remove();
  }
}
