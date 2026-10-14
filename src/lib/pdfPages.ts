/**
 * PDF → 쪽마다 JPEG 파일(브라우저 전용). 국어 모드가 PDF 도 받게 하려는 것이다 — 쪽 사진과 같은
 * `File` 로 만들어 돌려주므로 받는 쪽은 사진 흐름을 그대로 탄다(자르기·자동 찾기 모두 원본 해상도에서).
 *
 * pdfjs-dist 3.x(레거시 아님, `public/pdf.worker.min.js` 를 워커로 쓴다). 쪽이 크면 긴 변이 `MAX_SIDE` 를
 * 넘지 않게 배율을 낮춘다(메모리). 쪽 수 상한 `MAX_PAGES`.
 */
const MAX_SIDE = 3400;
const MAX_PAGES = 60;

export function isPdfFile(f: File): boolean {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

export async function pdfToImageFiles(file: File, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist/build/pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const total = Math.min(doc.numPages, MAX_PAGES);
    const base = file.name.replace(/\.pdf$/i, "");
    const out: File[] = [];
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      // 기본 2.5배(≈180dpi), 긴 변이 상한을 넘으면 낮춘다.
      const scale = Math.min(2.5, MAX_SIDE / Math.max(v1.width, v1.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("PDF 를 그릴 캔버스를 만들지 못했어요.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("PDF 쪽을 이미지로 바꾸지 못했어요.");
      out.push(new File([blob], `${base}-${String(n).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
      page.cleanup();
      onProgress?.(n, total);
    }
    return out;
  } finally {
    void doc.destroy();
  }
}
