import { toPng } from "html-to-image";
import { buildKicePdfOffThread } from "@/lib/kice/pdfOffThread";
import { frameKeyFor, loadFrameImages, loadKiceFrames, type KiceArea } from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import { waitForImages } from "@/lib/layout";
import { CIRCLED, type QDoc } from "./doc";
import { docHtml } from "./render";

/** 문항 하나를 미리보기와 같은 모양으로 화면 밖에서 찍어 PNG 로(평가원 틀의 단 폭에 맞춰 놓인다). */
export async function capture(doc: QDoc): Promise<Uint8Array> {
  return captureHtml(docHtml(doc), 640);
}

/**
 * 안쪽 SVG(백지도·그래프·그린 그림)를 미리 PNG 로 바꿔 둔다.
 * Safari 는 html-to-image 가 쓰는 foreignObject 안의 큰 인라인 SVG(나라 경로 수천 개, clip-path·pattern id)를
 * 빼먹거나 비워 그려서, 화면에는 있는데 PDF 에서는 지도가 빠지거나 어긋났다. 캔버스로 먼저 그려 두면 그 길을 안 탄다.
 */
async function rasterizeSvgs(root: HTMLElement): Promise<void> {
  const svgs = [...root.querySelectorAll("svg")].filter((el) => !el.parentElement?.closest("svg"));
  for (const svg of svgs) {
    const box = svg.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(box.width));
    clone.setAttribute("height", String(box.height));
    clone.removeAttribute("style");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.decoding = "sync";
      await new Promise<void>((ok, bad) => {
        img.onload = () => ok();
        img.onerror = () => bad(new Error("svg"));
        img.src = url;
      });
      const scale = 3;
      const c = document.createElement("canvas");
      c.width = Math.round(box.width * scale);
      c.height = Math.round(box.height * scale);
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const out = document.createElement("img");
      out.src = c.toDataURL("image/png");
      out.style.cssText = `display:block;width:${box.width}px;height:${box.height}px;max-width:100%`;
      svg.replaceWith(out);
    } catch {
      // 못 바꾸면 그대로 둔다(예전과 같다).
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

const isWebKit = () =>
  typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);

/** HTML 조각을 화면 밖에서 찍어 PNG 로(폭 px, 배율 2). */
export async function captureHtml(html: string, widthPx: number): Promise<Uint8Array> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;background:#fff`;
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    await rasterizeSvgs(host);
    await waitForImages(host);
    const node = host.firstElementChild as HTMLElement;
    const opts = { pixelRatio: 2, backgroundColor: "#fff" };
    // Safari 는 첫 캡처에서 글꼴·그림을 덜 싣는다 — 한 번 버리고 다시 찍는다(renderSolutionPng 와 같은 처방).
    if (isWebKit()) await toPng(node, opts).catch(() => "");
    const url = await toPng(node, opts);
    const b64 = url.split(",")[1];
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } finally {
    host.remove();
  }
}

export async function docsToPdf(
  docs: QDoc[],
  opts: { title: string; area: KiceArea; subject: string; withAnswers: boolean; withSolutions: boolean },
  onProgress?: (msg: string) => void,
): Promise<Uint8Array> {
  const key = frameKeyFor(opts.area);
  const [all, fonts] = await Promise.all([loadKiceFrames(), loadKiceFonts()]);
  const frames = all[key];
  const images = await loadFrameImages(frames);
  const pngs: Uint8Array[] = [];
  for (const [i, d] of docs.entries()) {
    onProgress?.(`문항 그리는 중 ${i + 1}/${docs.length}`);
    pngs.push(await capture(d));
  }
  const replace: Record<string, string> = {};
  if (opts.title.trim()) replace["2025학년도대학수학능력시험문제지"] = opts.title.trim();
  if (key === "tamgu") {
    replace["사회탐구영역"] = `${opts.area} 영역`;
    replace["(사회문화)"] = opts.subject ? `(${opts.subject})` : "";
  }
  onProgress?.("PDF 조립 중…");
  return buildKicePdfOffThread({
    frames,
    replace,
    fonts,
    images,
    problems: pngs.map((png) => ({ png, label: "" })),
    pagePattern: "auto",
    evenPages: true,
    answers: opts.withAnswers ? docs.filter((d) => d.answer).map((d) => ({ label: `${d.number}번`, answer: CIRCLED[d.answer - 1] })) : [],
    solutions: opts.withSolutions
      ? docs.filter((d) => d.solution.trim()).map((d) => ({ label: `${d.number}번`, answer: d.answer ? CIRCLED[d.answer - 1] : undefined, text: d.solution.trim() }))
      : undefined,
  });
}
