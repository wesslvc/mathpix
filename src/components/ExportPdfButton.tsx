"use client";

import { useState } from "react";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

type Props = {
  source: string;
  imageUrls: string[];
};

const PAGE_WIDTH = 595.28; // A4 (pt)
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const SOURCE_AREA_HEIGHT = 40;

export default function ExportPdfButton({ source, imageUrls }: Props) {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    try {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);

      const fontBytes = await fetch("/fonts/NanumMyeongjo-Regular.woff").then((r) =>
        r.arrayBuffer(),
      );
      const koreanFont = await pdfDoc.embedFont(fontBytes);

      const availableWidth = PAGE_WIDTH - MARGIN * 2;
      const availableHeight = PAGE_HEIGHT - MARGIN * 2 - SOURCE_AREA_HEIGHT;

      for (const url of imageUrls) {
        const imageBytes = await fetch(url).then((r) => r.arrayBuffer());
        const image = await pdfDoc.embedPng(imageBytes);

        const scale = Math.min(
          availableWidth / image.width,
          availableHeight / image.height,
          1,
        );
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;

        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        page.drawImage(image, {
          x: (PAGE_WIDTH - drawWidth) / 2,
          y: PAGE_HEIGHT - MARGIN - drawHeight,
          width: drawWidth,
          height: drawHeight,
        });

        const sourceText = `출처: ${source}`;
        const fontSize = 10;
        const textWidth = koreanFont.widthOfTextAtSize(sourceText, fontSize);
        page.drawText(sourceText, {
          x: (PAGE_WIDTH - textWidth) / 2,
          y: MARGIN / 2,
          size: fontSize,
          font: koreanFont,
          color: rgb(0.4, 0.4, 0.4),
        });
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${source.replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF 내보내기에 실패했습니다.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleExport}
        disabled={isExporting || imageUrls.length === 0}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-slate-50 disabled:opacity-50"
      >
        {isExporting ? "PDF 만드는 중..." : "PDF로 내보내기"}
      </button>
    </div>
  );
}
