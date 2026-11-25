import { toPng } from "html-to-image";
import { buildKicePdfOffThread } from "@/lib/kice/pdfOffThread";
import { frameKeyFor, loadFrameImages, loadKiceFrames, type KiceArea } from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import { waitForImages } from "@/lib/layout";
import { CIRCLED, type QDoc } from "./doc";
import { docHtml } from "./render";

/** 문항 하나를 미리보기와 같은 모양으로 화면 밖에서 찍어 PNG 로(평가원 틀의 단 폭에 맞춰 놓인다). */
async function capture(doc: QDoc): Promise<Uint8Array> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;background:#fff";
  host.innerHTML = docHtml(doc);
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    await waitForImages(host);
    const url = await toPng(host.firstElementChild as HTMLElement, { pixelRatio: 2, backgroundColor: "#fff" });
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
