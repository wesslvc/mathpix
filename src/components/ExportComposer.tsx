"use client";

import { useState } from "react";
import { PDFDocument, rgb } from "pdf-lib";

export type ComposerProblem = {
  id: string;
  imageUrl: string;
  source: string;
  origNumber: number | null;
};

type Props = {
  multi: boolean;
  defaultTitle: string;
  problems: ComposerProblem[];
};

const PAGE_WIDTH = 595.28; // A4 (pt)
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 34;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 34;
const COLUMN_GAP = 16;
const LABEL_GAP = 10;
const COLUMN_WIDTH = PAGE_WIDTH / 2 - COLUMN_GAP - MARGIN_X;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes.slice(0, PNG_SIGNATURE.length));
  return PNG_SIGNATURE.every((b, i) => head[i] === b);
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

/** 한글 텍스트를 canvas로 그려 PNG data URL과 pt 크기를 돌려준다. */
function renderCanvasText(
  text: string,
  opts: { fontPt: number; weight?: string; color?: string },
): { dataUrl: string; width: number; height: number } {
  const scale = 3;
  const fontPx = opts.fontPt * scale;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스를 생성할 수 없습니다.");
  const font = `${opts.weight ?? "normal"} ${fontPx}px "Nanum Myeongjo", serif`;
  ctx.font = font;
  const textWidth = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const canvasHeight = Math.ceil(fontPx * 1.4);
  canvas.width = textWidth;
  canvas.height = canvasHeight;
  ctx.font = font;
  ctx.fillStyle = opts.color ?? "#111111";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, canvasHeight / 2);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: textWidth / scale,
    height: canvasHeight / scale,
  };
}

function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${y}. ${Number(m)}. ${Number(d)}.`;
}

export default function ExportComposer({ multi, defaultTitle, problems }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [dateStr, setDateStr] = useState(todayString());
  const [order, setOrder] = useState<ComposerProblem[]>(problems);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    setOrder(next);
  }

  /** 각 문제 라벨: 단일이면 원래 번호, 복수 선택이면 1번부터 다시 매긴다. */
  function labelFor(problem: ComposerProblem, index: number): string {
    const num = multi
      ? index + 1
      : (problem.origNumber ?? index + 1);
    return `${problem.source} ${num}번`;
  }

  async function generate() {
    setIsGenerating(true);
    setError(null);
    try {
      if (typeof document !== "undefined" && document.fonts?.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }

      const pdfDoc = await PDFDocument.create();

      const titleImg = renderCanvasText(title || "오답 모음", {
        fontPt: 20,
        weight: "700",
        color: "#111111",
      });
      const dateImg = renderCanvasText(`시행일 : ${formatDate(dateStr)}`, {
        fontPt: 10,
        color: "#555555",
      });

      const skipped: number[] = [];

      for (let i = 0; i < order.length; i++) {
        const problem = order[i];
        let bytes: ArrayBuffer;
        try {
          bytes = await fetchArrayBuffer(problem.imageUrl);
        } catch {
          skipped.push(i + 1);
          continue;
        }
        if (!isPng(bytes)) {
          skipped.push(i + 1);
          continue;
        }
        let image;
        try {
          image = await pdfDoc.embedPng(bytes);
        } catch {
          skipped.push(i + 1);
          continue;
        }

        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        const isFirst = i === 0;

        // 첫 페이지 상단에 제목 + 시행일
        let contentTop = PAGE_HEIGHT - MARGIN_TOP;
        if (isFirst) {
          const tImg = await pdfDoc.embedPng(
            await (await fetch(titleImg.dataUrl)).arrayBuffer(),
          );
          page.drawImage(tImg, {
            x: (PAGE_WIDTH - titleImg.width) / 2,
            y: contentTop - titleImg.height,
            width: titleImg.width,
            height: titleImg.height,
          });
          contentTop -= titleImg.height + 6;

          const dImg = await pdfDoc.embedPng(
            await (await fetch(dateImg.dataUrl)).arrayBuffer(),
          );
          page.drawImage(dImg, {
            x: (PAGE_WIDTH - dateImg.width) / 2,
            y: contentTop - dateImg.height,
            width: dateImg.width,
            height: dateImg.height,
          });
          contentTop -= dateImg.height + 18;
        }

        // 가운데 세로 구분선
        page.drawLine({
          start: { x: PAGE_WIDTH / 2, y: MARGIN_BOTTOM },
          end: { x: PAGE_WIDTH / 2, y: contentTop },
          thickness: 0.7,
          color: rgb(0.78, 0.78, 0.78),
        });

        // 문제 라벨 (예: "강기원모의고사2회 22번")
        const label = renderCanvasText(labelFor(problem, i), {
          fontPt: 10,
          weight: "700",
          color: "#111111",
        });
        const labelImg = await pdfDoc.embedPng(
          await (await fetch(label.dataUrl)).arrayBuffer(),
        );
        page.drawImage(labelImg, {
          x: MARGIN_X,
          y: contentTop - label.height,
          width: label.width,
          height: label.height,
        });

        // 문제 이미지: 라벨 아래, 왼쪽 컬럼. 저장 이미지는 2배 해상도라 0.5가 자연 크기.
        const imgTop = contentTop - label.height - LABEL_GAP;
        const maxImgHeight = imgTop - MARGIN_BOTTOM;
        const scale = Math.min(
          COLUMN_WIDTH / image.width,
          maxImgHeight / image.height,
          0.5,
        );
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        const imgX = MARGIN_X;
        const imgY = imgTop - drawHeight;
        page.drawImage(image, {
          x: imgX,
          y: imgY,
          width: drawWidth,
          height: drawHeight,
        });

        // 문제 영역을 얇은 테두리로 표시한다.
        const pad = 5;
        page.drawRectangle({
          x: imgX - pad,
          y: imgY - pad,
          width: drawWidth + pad * 2,
          height: drawHeight + pad * 2,
          borderColor: rgb(0.6, 0.6, 0.6),
          borderWidth: 0.7,
        });
      }

      if (pdfDoc.getPageCount() === 0) {
        throw new Error("출력할 오답 이미지를 하나도 불러오지 못했습니다.");
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${(title || "오답모음").replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      link.click();
      URL.revokeObjectURL(objectUrl);

      if (skipped.length > 0) {
        setError(`${skipped.join(", ")}번 문제 이미지는 불러오지 못해 제외했습니다.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF 만들기에 실패했습니다.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          제목
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={multi ? "제목을 입력하세요 (예: 미적분 오답 모음)" : "제목"}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          시행일
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            className="w-48 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <span className="text-xs text-slate-400">
            입력하지 않으면 오늘 날짜로 인쇄됩니다.
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">
            인쇄 순서 ({order.length}문제)
          </h2>
          <span className="text-xs text-slate-400">
            순서를 바꾸지 않으면 추가한 순서대로 인쇄됩니다.
          </span>
        </div>

        <ol className="flex flex-col gap-2">
          {order.map((problem, index) => (
            <li
              key={problem.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2"
            >
              <span className="w-6 shrink-0 text-center text-sm font-medium text-slate-500">
                {index + 1}
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={problem.imageUrl}
                alt="오답"
                className="h-16 w-16 shrink-0 rounded border border-slate-200 object-contain"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                {labelFor(problem, index)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === order.length - 1}
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  ↓
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={generate}
          disabled={isGenerating || order.length === 0}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isGenerating ? "PDF 만드는 중..." : "PDF 만들기"}
        </button>
      </div>
    </div>
  );
}
