"use client";

import { useRef, useState } from "react";
import { cropImageToDataUrl, fileToDataUrl, isHeicFile, loadImage } from "@/lib/cropImage";
import {
  PROBLEM_INPUT_DIM,
  prepareFigureForModel,
  rasterToSvg,
  stitchVertically,
} from "@/lib/figureImage";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { toStoredFigures, type StoredBoxRange } from "@/lib/storedFigures";
import type { CardFigure } from "@/lib/cardHtml";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import type { DiagramLayout } from "@/lib/diagramLayout";
import type { DetectedProblem } from "@/lib/detectProblems";
import { useFigureJobs } from "./FigureJobsProvider";

/**
 * 지면 한 장을 문제 여러 개로 잘라 한꺼번에 넣는 패널. **무제한 계정 전용.**
 *
 * 한 장에 문제가 여러 개 있는 지면(모의고사·문제집 한 쪽)을 올리면 Gemini 가
 * 문제마다의 영역을 찾아 주고, 그 자리대로 잘라 문제 하나씩 만든다. 이어서
 * "모두 AI로 재생성"을 누르면 잘린 것들이 전부 **문제 전체 다시 그리기** 큐에
 * 들어가 한 개씩 순서대로 처리된다.
 *
 * 잘라 넣는 것과 다시 그리는 것을 나눠 둔 이유: 영역 인식은 값이 싸고 빠르지만
 * 다시 그리기는 문제마다 1분쯤 걸리는 유료 호출이다. 잘린 결과를 먼저 눈으로
 * 보고 잘못 잡힌 것을 지운 다음 돌리는 편이 안전하다.
 */

/** 통째로 그린 문제 이미지의 배치(AddProblemFlow와 같은 값). */
const WHOLE_PROBLEM_LAYOUT: DiagramLayout = { scale: 100, offsetX: 0, offsetY: 0 };

/** 인식한 영역을 자를 때 사방으로 더 주는 여유(비율). 글자가 잘리는 걸 막는다. */
const PAD = 0.01;

/** `parts` 가 2 이상이면 단을 넘어 이어진 문제를 이어 붙인 것이다. */
type Piece = { id: string; crop: string; parts: number };

type Props = {
  /** 문제 하나를 저장하고 그 행 id를 돌려준다(AddProblemFlow가 준다). */
  onSave: (args: {
    pngDataUrl: string;
    text: string;
    answer: string;
    answerType: "choice";
    boxRange: StoredBoxRange;
  }) => Promise<string>;
};

export default function BatchSplitPanel({ onSave }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { enqueue } = useFigureJobs();

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPieces([]);
    if (isHeicFile(file)) {
      setError("HEIC 사진은 아직 지원하지 않습니다. JPG나 PNG로 바꿔 올려주세요.");
      return;
    }
    try {
      setPageImage(await fileToDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 불러오지 못했습니다.");
    }
  }

  async function detect() {
    if (!pageImage) return;
    setBusy("문제 영역을 찾는 중...");
    setError(null);
    try {
      // 자리를 재는 데는 큰 해상도가 필요 없다. 자르는 건 원본에서 한다.
      const small = await prepareFigureForModel(pageImage, PROBLEM_INPUT_DIM);
      const res = await fetch("/api/detect-problems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: small }),
      });
      const json: { problems?: DetectedProblem[]; error?: string } = await res.json();
      if (!res.ok) throw new Error(json.error ?? "문제 영역 인식에 실패했습니다.");
      const found = json.problems ?? [];
      if (found.length === 0) {
        setError("문제 영역을 찾지 못했습니다. 지면이 또렷하게 나온 사진으로 다시 해보세요.");
        setPieces([]);
        return;
      }

      const img = await loadImage(pageImage);
      const cut = (b: DetectedProblem["boxes"][number]) => {
        const x = Math.max(0, b.x - PAD) * img.naturalWidth;
        const y = Math.max(0, b.y - PAD) * img.naturalHeight;
        const w = Math.min(1 - b.x + PAD, b.w + PAD * 2) * img.naturalWidth;
        const h = Math.min(1 - b.y + PAD, b.h + PAD * 2) * img.naturalHeight;
        return cropImageToDataUrl(img, { x, y, width: w, height: h });
      };
      // 단을 넘어 이어진 문제는 조각을 **읽는 차례대로 세로로 이어 붙인다.**
      const next: Piece[] = await Promise.all(
        found.map(async (prob) => ({
          id: crypto.randomUUID(),
          crop: await stitchVertically(prob.boxes.map(cut)),
          parts: prob.boxes.length,
        })),
      );
      setPieces(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "문제 영역 인식에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * 잘린 것들을 문제로 저장하고 다시 그리기 큐에 넣는다.
   *
   * 저장을 **먼저** 한다. 그래야 행 id를 큐에 함께 넘길 수 있고, 브라우저를
   * 닫아도 서버가 결과를 그 행에 직접 저장한다(`persistWholeProblem`).
   * 저장되는 그림은 우선 원본 크롭이라, 다시 그리기가 끝나기 전에 봐도
   * 빈 자리가 아니라 멀쩡한 문제가 들어 있다.
   */
  async function regenerateAll() {
    if (pieces.length === 0) return;
    setError(null);
    let done = 0;
    for (const piece of pieces) {
      setBusy(`문제를 넣는 중... (${done + 1}/${pieces.length})`);
      try {
        const figure: CardFigure = {
          id: piece.id,
          markup: await rasterToSvg(piece.crop),
          layout: WHOLE_PROBLEM_LAYOUT,
          position: 0,
        };
        const pngDataUrl = await renderCardOffscreen({
          text: "",
          boxOverride: undefined,
          fontSizePx: ptToPx(DEFAULT_FONT_PT),
          figures: [figure],
        });
        const problemId = await onSave({
          pngDataUrl,
          text: "",
          answer: "",
          answerType: "choice",
          boxRange: {
            ranges: null,
            fontPt: DEFAULT_FONT_PT,
            figures: toStoredFigures([figure]),
          },
        });
        enqueue({
          id: piece.id,
          problemKey: `batch:${problemId}`,
          label: `${done + 1}번째 문제`,
          crop: piece.crop,
          mode: "problem",
          problemId,
        });
        done += 1;
      } catch (err) {
        setError(
          `${done + 1}번째 문제에서 멈췄습니다: ` +
            (err instanceof Error ? err.message : "알 수 없는 오류"),
        );
        break;
      }
    }
    setBusy(null);
    if (done > 0) {
      // 넣은 것은 목록에서 뺀다(같은 것을 두 번 넣지 않게).
      setPieces((prev) => prev.slice(done));
      setPageImage(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
          무제한 계정 전용
        </span>
        <span className="text-sm font-medium text-slate-700">지면 통째로 넣기</span>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        문제가 여러 개 있는 지면을 올리면 문제마다의 영역을 찾아 하나씩 잘라 줍니다.
        잘린 것을 보고 잘못 잡힌 것을 지운 다음 “모두 AI로 재생성”을 누르면 전부
        큐에 들어가 한 개씩 다시 그려집니다.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="text-xs text-slate-600 file:mr-2 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:text-slate-700"
      />

      {pageImage && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void detect()}
            disabled={busy !== null}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            문제 영역 인식
          </button>
          {pieces.length > 0 && (
            <button
              type="button"
              onClick={() => void regenerateAll()}
              disabled={busy !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              모두 AI로 재생성 ({pieces.length}개)
            </button>
          )}
        </div>
      )}

      {busy && <p className="text-xs text-slate-500">{busy}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {pieces.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {pieces.map((p, i) => (
            <li
              key={p.id}
              className="relative overflow-hidden rounded-lg border border-slate-200 bg-white"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.crop} alt="" className="w-full object-contain" />
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[11px] text-white">
                {i + 1}
                {p.parts > 1 && ` · ${p.parts}조각 합침`}
              </span>
              <button
                type="button"
                onClick={() => setPieces((prev) => prev.filter((x) => x.id !== p.id))}
                disabled={busy !== null}
                aria-label="이 영역 빼기"
                className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-[11px] text-white hover:bg-red-600 disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
