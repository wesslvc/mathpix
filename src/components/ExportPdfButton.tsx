"use client";

import { useState } from "react";
import { PDFDocument, rgb } from "pdf-lib";

type Props = {
  source: string;
  imageUrls: string[];
};

const PAGE_WIDTH = 595.28; // A4 (pt)
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 34;
const MARGIN_TOP = 34;
const MARGIN_BOTTOM = 34;
const COLUMN_GAP = 16; // 가운데 구분선 양옆 여백
const LABEL_GAP = 12; // 출처 라벨과 문제 이미지 사이 간격

// 시험지처럼 왼쪽 컬럼에 문제를 배치한다. 컬럼 폭 = 페이지 절반 - 여백.
const COLUMN_WIDTH = PAGE_WIDTH / 2 - COLUMN_GAP - MARGIN_X;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes.slice(0, PNG_SIGNATURE.length));
  return PNG_SIGNATURE.every((byte, i) => head[i] === byte);
}

async function fetchArrayBuffer(url: string, label: string): Promise<ArrayBuffer> {
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

/**
 * 출처 표기 텍스트를 브라우저 canvas로 그려 PNG data URL로 반환한다.
 * pdf-lib에 한글 폰트를 직접 임베드하면 fontkit이 서브셋 폰트의 글리프
 * 폭 계산에서 에러를 던지므로, 브라우저가 네이티브로 렌더링한 텍스트
 * 이미지를 대신 삽입한다.
 */
function renderSourceLabel(text: string): {
  dataUrl: string;
  width: number;
  height: number;
} {
  const fontSizePt = 9;
  const scale = 3; // 선명도를 위해 3배 해상도로 그린다.
  const fontPx = fontSizePt * scale;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스를 생성할 수 없습니다.");

  const fontFamily = '"Nanum Myeongjo", serif';
  ctx.font = `${fontPx}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  const canvasHeight = Math.ceil(fontPx * 1.4);

  canvas.width = Math.max(1, textWidth);
  canvas.height = canvasHeight;

  // 캔버스 크기를 바꾸면 컨텍스트가 초기화되므로 폰트를 다시 지정한다.
  ctx.font = `${fontPx}px ${fontFamily}`;
  ctx.fillStyle = "#333333";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, canvasHeight / 2);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: textWidth / scale,
    height: canvasHeight / scale,
  };
}

export default function ExportPdfButton({ source, imageUrls }: Props) {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    try {
      const pdfDoc = await PDFDocument.create();

      // 웹폰트가 로드된 뒤에 출처 텍스트를 그려야 나눔명조로 렌더링된다.
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
      const label = renderSourceLabel(`문항 출처 : ${source}`);
      const labelBytes = await (await fetch(label.dataUrl)).arrayBuffer();
      const labelImage = await pdfDoc.embedPng(labelBytes);

      const skipped: number[] = [];

      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        const imageBytes = await fetchArrayBuffer(url, `${i + 1}번째 오답 이미지`);

        if (!isPng(imageBytes)) {
          skipped.push(i + 1);
          continue;
        }

        let image;
        try {
          image = await pdfDoc.embedPng(imageBytes);
        } catch {
          skipped.push(i + 1);
          continue;
        }

        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

        // 가운데 세로 구분선 (시험지 느낌)
        page.drawLine({
          start: { x: PAGE_WIDTH / 2, y: MARGIN_BOTTOM },
          end: { x: PAGE_WIDTH / 2, y: PAGE_HEIGHT - MARGIN_TOP },
          thickness: 0.7,
          color: rgb(0.75, 0.75, 0.75),
        });

        // 출처 라벨: 왼쪽 컬럼 상단
        const labelTop = PAGE_HEIGHT - MARGIN_TOP;
        page.drawImage(labelImage, {
          x: MARGIN_X,
          y: labelTop - label.height,
          width: label.width,
          height: label.height,
        });

        // 문제 이미지: 출처 아래, 왼쪽 정렬. 저장된 이미지는 2배 해상도(PNG)라
        // 절반 크기가 자연 크기다. 컬럼 폭/남은 높이를 넘으면 함께 축소한다.
        const maxImgHeight =
          labelTop - label.height - LABEL_GAP - MARGIN_BOTTOM;
        const scale = Math.min(
          COLUMN_WIDTH / image.width,
          maxImgHeight / image.height,
          0.5,
        );
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        const imgTop = labelTop - label.height - LABEL_GAP;

        page.drawImage(image, {
          x: MARGIN_X,
          y: imgTop - drawHeight,
          width: drawWidth,
          height: drawHeight,
        });
      }

      if (pdfDoc.getPageCount() === 0) {
        throw new Error(
          `저장된 오답 이미지를 모두 불러오지 못해 PDF를 만들 수 없습니다 (${skipped.length}개 실패).`,
        );
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${source.replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      link.click();
      URL.revokeObjectURL(objectUrl);

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
