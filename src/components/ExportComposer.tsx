"use client";

import { useState } from "react";
import { PDFDocument, rgb } from "pdf-lib";
import dynamic from "next/dynamic";

// 평가원 양식은 틀 좌표(수십 KB)와 글꼴 다섯 벌을 받아온다. 일반 A4 로 뽑는
// 사람에게까지 그 짐을 지울 이유가 없어서 고를 때 받아온다.
const KiceExportPanel = dynamic(() => import("./KiceExportPanel"), {
  ssr: false,
  loading: () => <p className="text-sm text-slate-500">평가원 양식 준비 중...</p>,
});

export type ComposerProblem = {
  id: string;
  imageUrl: string;
  /** 점수까지 붙은 출처 표기(예: "강대2회(96/100)"). */
  source: string;
  /** 점수를 뺀 출처(예: "강대2회"). 같은 출처가 반복될 때 쓴다. */
  sourceBase: string;
  origNumber: number | null;
  /** 사용자가 손으로 정해 둔 번호. 있으면 무조건 이걸 쓴다. */
  manualNumber: number | null;
  answer: string;
};

type Props = {
  multi: boolean;
  defaultTitle: string;
  examDate: string;
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
/** 슬롯 사이 세로 간격(한 페이지에 여러 문제를 넣을 때). */
const ROW_GAP = 18;

/**
 * 한 페이지에 문제를 몇 개 넣을지.
 *
 * 원래는 무조건 1개였다(왼쪽에 문제, 오른쪽은 풀이 공간). 탐구처럼 문제가
 * 짧은 과목에서는 종이가 너무 남아서 선택할 수 있게 했다.
 *   1개 — 왼쪽에 문제, 오른쪽은 통째로 풀이 공간 (기존 동작)
 *   2개 — 왼쪽 단과 오른쪽 단에 하나씩 나란히
 *   4개 — 양쪽 2단씩. 좌상 → 좌하 → 우상 → 우하 순으로 채운다
 */
const PER_PAGE_OPTIONS = [1, 2, 4] as const;
type PerPage = (typeof PER_PAGE_OPTIONS)[number];

const PER_PAGE_LABEL: Record<PerPage, string> = {
  1: "1개 (풀이 공간 넓게)",
  2: "2개 (좌우로 나란히)",
  4: "4개 (모아보기)",
};

type Slot = { x: number; top: number; width: number; height: number };

/**
 * 이 페이지에서 문제를 놓을 자리들. top은 위쪽 y좌표(PDF는 아래가 0이라
 * 아래로 내려갈수록 값이 작아진다).
 */
function slotsFor(perPage: PerPage, contentTop: number): Slot[] {
  const usableHeight = contentTop - MARGIN_BOTTOM;
  const rightX = PAGE_WIDTH / 2 + COLUMN_GAP;

  if (perPage === 1) {
    return [
      { x: MARGIN_X, top: contentTop, width: COLUMN_WIDTH, height: usableHeight },
    ];
  }
  if (perPage === 2) {
    // 왼쪽 단과 오른쪽 단에 하나씩. 둘 다 페이지 높이를 통째로 쓴다.
    return [
      { x: MARGIN_X, top: contentTop, width: COLUMN_WIDTH, height: usableHeight },
      { x: rightX, top: contentTop, width: COLUMN_WIDTH, height: usableHeight },
    ];
  }

  // 좌상 → 좌하 → 우상 → 우하. 왼쪽 단을 세로로 다 채운 뒤 오른쪽으로 넘어간다
  // (신문처럼 읽는 순서라 문제 번호가 위아래로 이어진다).
  const rowHeight = (usableHeight - ROW_GAP) / 2;
  const bottomTop = contentTop - rowHeight - ROW_GAP;
  return [
    { x: MARGIN_X, top: contentTop, width: COLUMN_WIDTH, height: rowHeight },
    { x: MARGIN_X, top: bottomTop, width: COLUMN_WIDTH, height: rowHeight },
    { x: rightX, top: contentTop, width: COLUMN_WIDTH, height: rowHeight },
    { x: rightX, top: bottomTop, width: COLUMN_WIDTH, height: rowHeight },
  ];
}

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

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${y}. ${Number(m)}. ${Number(d)}.`;
}

/**
 * 정답표를 canvas로 그려 PNG data URL과 pt 크기를 돌려준다.
 * 문제 수가 많으면 2열로 배치한다. 한글은 canvas로 그려 폰트 임베드를 피한다.
 */
function renderAnswerTableCanvas(
  rows: { label: string; answer: string }[],
): { dataUrl: string; width: number; height: number } {
  const scale = 3;
  const fontPt = 12;
  const titlePt = 18;
  const rowHpt = fontPt * 2;
  const titleGapPt = titlePt * 2;
  const innerGapPt = 22; // 번호와 정답 사이
  const colGapPt = 44; // 열과 열 사이

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스를 생성할 수 없습니다.");

  const bodyFont = `${fontPt * scale}px "Nanum Myeongjo", serif`;
  const titleFont = `700 ${titlePt * scale}px "Nanum Myeongjo", serif`;

  const n = rows.length;
  const cols = n > 14 ? 2 : 1;
  const rowsPerCol = Math.ceil(n / cols);

  // 각 열의 번호/정답 최대 너비를 재서 정답을 세로로 정렬한다.
  ctx.font = bodyFont;
  const labelWpx: number[] = [];
  const answerWpx: number[] = [];
  for (let c = 0; c < cols; c++) {
    let lw = 0;
    let aw = 0;
    for (let r = 0; r < rowsPerCol; r++) {
      const idx = c * rowsPerCol + r;
      if (idx >= n) break;
      lw = Math.max(lw, ctx.measureText(rows[idx].label).width);
      aw = Math.max(aw, ctx.measureText(rows[idx].answer || "-").width);
    }
    labelWpx.push(lw);
    answerWpx.push(aw);
  }
  const innerGapPx = innerGapPt * scale;
  const colGapPx = colGapPt * scale;
  const colWidthsPx = labelWpx.map((lw, c) => lw + innerGapPx + answerWpx[c]);
  const contentWidthPx =
    colWidthsPx.reduce((a, b) => a + b, 0) + colGapPx * (cols - 1);

  ctx.font = titleFont;
  const titleWidthPx = ctx.measureText("정답표").width;

  const widthPx = Math.ceil(Math.max(contentWidthPx, titleWidthPx)) + 4;
  const titleGapPx = titleGapPt * scale;
  const rowHpx = rowHpt * scale;
  const heightPx = Math.ceil(titleGapPx + rowsPerCol * rowHpx) + 4;

  canvas.width = widthPx;
  canvas.height = heightPx;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);

  ctx.textBaseline = "middle";
  ctx.font = titleFont;
  ctx.fillStyle = "#111111";
  ctx.fillText("정답표", 0, titleGapPx / 2);

  ctx.font = bodyFont;
  let x = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rowsPerCol; r++) {
      const idx = c * rowsPerCol + r;
      if (idx >= n) break;
      const y = titleGapPx + r * rowHpx + rowHpx / 2;
      ctx.fillStyle = "#555555";
      ctx.fillText(rows[idx].label, x, y);
      ctx.fillStyle = "#111111";
      ctx.fillText(rows[idx].answer || "-", x + labelWpx[c] + innerGapPx, y);
    }
    x += colWidthsPx[c] + colGapPx;
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: widthPx / scale,
    height: heightPx / scale,
  };
}

export default function ExportComposer({
  multi,
  defaultTitle,
  examDate,
  problems,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [order, setOrder] = useState<ComposerProblem[]>(problems);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [perPage, setPerPage] = useState<PerPage>(1);
  /** 어떤 종이에 뽑을지. 평가원 양식은 한글 파일로 나간다(글꼴 때문에). */
  const [layout, setLayout] = useState<"a4" | "kice">("a4");

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    setOrder(next);
  }

  /** 각 문제 번호: 단일이면 원래 번호, 복수 선택이면 1번부터 다시 매긴다. */
  /**
   * 문제에 찍을 번호.
   *
   * 손으로 정해 둔 값이 있으면 **무엇보다 우선**한다 — 실제 시험지 번호를
   * 그대로 쓰고 싶을 때가 있다(15·22·28처럼 띄엄띄엄). 없으면 예전대로:
   * 여러 묶음을 한 번에 뽑을 때는 차례대로, 한 묶음이면 본문에서 뽑은 번호.
   */
  function numberFor(problem: ComposerProblem, index: number): number {
    if (problem.manualNumber != null) return problem.manualNumber;
    return multi ? index + 1 : (problem.origNumber ?? index + 1);
  }

  /**
   * 각 문제 라벨.
   *
   * 같은 내용을 페이지마다 반복하지 않는 것이 원칙이다.
   * - 단일 묶음: 출처와 점수가 이미 첫 페이지 제목에 있으므로 번호만 적는다.
   * - 여러 묶음: 출처는 문제마다 다를 수 있으니 남기되, 점수는 그 출처가 처음
   *   나오는 페이지에서 한 번만 적는다.
   */
  function labelFor(problem: ComposerProblem, index: number): string {
    const n = numberFor(problem, index);
    if (!multi) return `${n}번`;

    const firstOfSource =
      order.findIndex((p) => p.sourceBase === problem.sourceBase) === index;
    return `${firstOfSource ? problem.source : problem.sourceBase} ${n}번`;
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
      const dateImg = renderCanvasText(`시행일 : ${formatDate(examDate)}`, {
        fontPt: 10,
        color: "#555555",
      });

      const skipped: number[] = [];

      // 이미지를 한 장씩 순서대로 내려받으면 문제 수만큼 네트워크 왕복이
      // 쌓여 느리다. 먼저 전부 동시에 내려받고, PDF에 그려 넣는(embedPng)
      // 단계만 순서대로 처리한다.
      const fetched = await Promise.all(
        order.map(async (problem) => {
          try {
            const bytes = await fetchArrayBuffer(problem.imageUrl);
            return isPng(bytes) ? bytes : null;
          } catch {
            return null;
          }
        }),
      );

      // 페이지와 슬롯을 직접 굴린다. 슬롯이 차면 새 페이지를 만든다.
      let page: ReturnType<typeof pdfDoc.addPage> | null = null;
      let slots: Slot[] = [];
      let slotIndex = 0;
      let isFirstPage = true;

      for (let i = 0; i < order.length; i++) {
        const problem = order[i];
        const bytes = fetched[i];
        if (!bytes) {
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

        if (page === null || slotIndex >= slots.length) {
          page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
          let contentTop = PAGE_HEIGHT - MARGIN_TOP;

          // 첫 페이지 상단에 제목 + 시행일
          if (isFirstPage) {
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
            isFirstPage = false;
          }

          // 가운데 세로 구분선. 4개씩 넣을 때는 오른쪽도 문제 자리라
          // 단 사이 구분선 역할을 그대로 한다.
          page.drawLine({
            start: { x: PAGE_WIDTH / 2, y: MARGIN_BOTTOM },
            end: { x: PAGE_WIDTH / 2, y: contentTop },
            thickness: 0.7,
            color: rgb(0.78, 0.78, 0.78),
          });

          slots = slotsFor(perPage, contentTop);
          slotIndex = 0;
        }

        const slot = slots[slotIndex++];

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
          x: slot.x,
          y: slot.top - label.height,
          width: label.width,
          height: label.height,
        });

        // 문제 이미지: 라벨 아래. 저장 이미지는 2배 해상도라 0.5가 자연 크기.
        const imgTop = slot.top - label.height - LABEL_GAP;
        const maxImgHeight = imgTop - (slot.top - slot.height);
        const scale = Math.min(
          slot.width / image.width,
          maxImgHeight / image.height,
          0.5,
        );
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        const imgX = slot.x;
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

      // 맨 마지막 페이지에 정답표 — 정답이 입력된 문제만 모은다.
      const answerRows = order
        .map((problem, i) => ({
          label: `${numberFor(problem, i)}번`,
          answer: (problem.answer ?? "").trim(),
        }))
        .filter((row) => row.answer !== "");

      if (answerRows.length > 0) {
        const table = renderAnswerTableCanvas(answerRows);
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        const contentTop = PAGE_HEIGHT - MARGIN_TOP;
        const availW = PAGE_WIDTH - MARGIN_X * 2;
        const availH = contentTop - MARGIN_BOTTOM;
        const s = Math.min(availW / table.width, availH / table.height, 1);
        const w = table.width * s;
        const h = table.height * s;
        const tImg = await pdfDoc.embedPng(
          await (await fetch(table.dataUrl)).arrayBuffer(),
        );
        page.drawImage(tImg, {
          x: (PAGE_WIDTH - w) / 2,
          y: contentTop - h,
          width: w,
          height: h,
        });
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
        <p className="text-xs text-slate-400">
          시행일 : {formatDate(examDate)} (실모 추가 시 정한 날짜)
        </p>
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

      {/* 어떤 양식으로 뽑을지. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-700">양식</span>
        <div className="flex gap-1">
          {(
            [
              ["a4", "일반 (A4 PDF)"],
              ["kice", "평가원 문제지"],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              onClick={() => setLayout(key)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                layout === key
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {layout === "kice" ? (
        <KiceExportPanel
          title={title}
          items={order.map((problem, index) => ({
            id: problem.id,
            imageUrl: problem.imageUrl,
            label: labelFor(problem, index),
            answerLabel: `${numberFor(problem, index)}번`,
            answer: problem.answer ?? "",
          }))}
        />
      ) : (
        <>
      {/* 한 페이지에 몇 문제를 넣을지. 탐구처럼 문제가 짧으면 1개는 종이가
          너무 남는다. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-700">
          페이지당 문제 수
        </span>
        <div className="flex gap-1">
          {PER_PAGE_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPerPage(n)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                perPage === n
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {PER_PAGE_LABEL[n]}
            </button>
          ))}
        </div>
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
        </>
      )}
    </div>
  );
}
