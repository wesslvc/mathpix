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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// "wOFF" — WOFF 폰트 컨테이너의 매직 넘버
const WOFF_SIGNATURE = [0x77, 0x4f, 0x46, 0x46];

function hasSignature(bytes: ArrayBuffer, signature: number[]): boolean {
  const head = new Uint8Array(bytes.slice(0, signature.length));
  return signature.every((byte, i) => head[i] === byte);
}

async function fetchArrayBuffer(url: string, label: string): Promise<ArrayBuffer> {
  // 캐시가 예전(폰트가 아직 배포에 안 들어가 있던 시절)의 손상된 응답을
  // 물고 있을 가능성을 없애기 위해 항상 네트워크에서 새로 받아온다.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`${label}을(를) 불러오지 못했습니다 (HTTP ${res.status}).`);
  }
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error(`${label} 응답이 비어 있습니다.`);
  }
  return buffer;
}

export default function ExportPdfButton({ source, imageUrls }: Props) {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    try {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);

      const fontBytes = await fetchArrayBuffer(
        "/fonts/NanumMyeongjo-Regular.woff",
        "출처 표기용 폰트",
      );
      if (!hasSignature(fontBytes, WOFF_SIGNATURE)) {
        throw new Error(
          "출처 표기용 폰트 파일이 손상된 상태로 전송됐습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.",
        );
      }
      let koreanFont;
      try {
        koreanFont = await pdfDoc.embedFont(fontBytes);
      } catch {
        throw new Error(
          "출처 표기용 폰트를 읽는 데 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.",
        );
      }

      const availableWidth = PAGE_WIDTH - MARGIN * 2;
      const availableHeight = PAGE_HEIGHT - MARGIN * 2 - SOURCE_AREA_HEIGHT;

      const skipped: number[] = [];

      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        const imageBytes = await fetchArrayBuffer(url, `${i + 1}번째 오답 이미지`);

        if (!hasSignature(imageBytes, PNG_SIGNATURE)) {
          skipped.push(i + 1);
          continue;
        }

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

      if (pdfDoc.getPageCount() === 0) {
        throw new Error(
          `저장된 오답 이미지를 모두 불러오지 못해 PDF를 만들 수 없습니다 (${skipped.length}개 실패).`,
        );
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${source.replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      link.click();
      URL.revokeObjectURL(url);

      if (skipped.length > 0) {
        setError(
          `${skipped.join(", ")}번째 이미지는 손상되어 PDF에서 제외했습니다.`,
        );
      }
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
