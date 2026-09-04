"use client";

import { useRef, useState } from "react";
import { cropImageToDataUrl, fileToDataUrl, isHeicFile, loadImage } from "@/lib/cropImage";
import {
  DETECT_INPUT_DIM,
  MAX_UPLOAD_CHARS,
  PROBLEM_INPUT_DIM,
  PROBLEM_MAX_HEIGHT,
  rasterToSvg,
} from "@/lib/figureImage";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { toStoredFigures, type StoredBoxRange } from "@/lib/storedFigures";
import type { CardFigure } from "@/lib/cardHtml";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import type { DiagramLayout } from "@/lib/diagramLayout";
import type { DetectedKoreanRegion } from "@/lib/detectProblems";
import type { ProblemBox } from "@/lib/problemBoxes";
import { enhanceContrast } from "@/lib/autoContrast";
import { parseProblemNumber } from "@/lib/problemNumber";
import { useFigureJobs } from "./FigureJobsProvider";

/**
 * **국어 모드** — 지문 한 편과 그에 딸린 문항들을 한 세트로 넣는다.
 *
 * 국어가 다른 과목과 다른 점은 **지문**이다. 문항을 낱개로 넣으면 지문이 어느
 * 문제 것인지 알 수 없고, 인쇄할 때 지문과 문제가 다른 쪽으로 갈라져 앞뒤로
 * 넘겨 가며 풀어야 한다. 그래서 같은 `setId` 로 묶어 두고(`koreanSet.ts`),
 * 내보낼 때 **짝수 쪽 지문 · 홀수 쪽 문제**로 펼침면에 나란히 놓는다.
 *
 * 하는 일이 네 가지다:
 *  0. Mathpix 로 지면을 읽고 그 글자를 LUNA 에 보내 **제목**을 짓는다
 *     (독서는 주제, 복합지문은 `(복합) 주제1 + 주제2`, 문학은 저자·작품명).
 *     제목은 첫 장 목차에 그대로 적힌다.
 *  1. **지문 영역**을 찾아 잘라 낸다.
 *  2. **문제 영역**을 찾아 잘라 내고 같은 세트로 묶는다.
 *  3. 잘린 것들을 저장하고(원본 그대로) 원하면 AI 재생성 큐에 넣는다.
 *
 * **영역 찾기는 한 번의 호출로 지문과 문제를 함께** 받는다(`mode: "korean"`).
 * 나누면 그만큼 돈이 더 든다.
 *
 * **지문 없는 문항**은 체크 하나로 세트를 만들지 않고 보통 문제로 넣는다 —
 * 어휘·문법 단독 문항처럼 지문이 없는 것이 실제로 있다.
 */

/** 통째로 그린 문제 이미지의 배치(다른 패널과 같은 값). */
const WHOLE_PROBLEM_LAYOUT: DiagramLayout = { scale: 100, offsetX: 0, offsetY: 0 };

/** 자동으로 찾은 영역을 자를 때 사방으로 더 주는 여유(지면 크기 대비 비율). */
const PAD = 0.004;

type Piece = {
  id: string;
  kind: "passage" | "question";
  crop: string;
  box: ProblemBox;
  no: number | null;
};

type Props = {
  /** 문제 하나를 저장하고 그 행 id를 돌려준다(AddProblemFlow가 준다). */
  onSave: (args: {
    pngDataUrl: string;
    text: string;
    answer: string;
    answerType: "choice";
    boxRange: StoredBoxRange;
  }) => Promise<string>;
  unlimited?: boolean;
  /** 문제 하나를 다시 그리는 데 드는 토큰. 서버가 알려준 값을 그대로 쓴다. */
  figureCost?: number | null;
  onDone?: () => void;
};

export default function KoreanModePanel({ onSave, unlimited = false, figureCost, onDone }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { enqueue } = useFigureJobs();

  /** 고른 사진. 자르는 재료는 원본(`pageFile`)이고 화면에 띄우는 건 축소본이다. */
  const [pageFile, setPageFile] = useState<File | null>(null);
  const [pageImage, setPageImage] = useState<string | null>(null);

  const [pieces, setPieces] = useState<Piece[]>([]);
  const [title, setTitle] = useState("");
  const [titleNote, setTitleNote] = useState<string | null>(null);
  /** 지문 없는 문항 묶음이면 세트를 만들지 않는다. */
  const [noPassage, setNoPassage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function reset() {
    setPieces([]);
    setTitle("");
    setTitleNote(null);
    setPageImage(null);
    setPageFile(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function pickFile(file: File | null) {
    setError(null);
    setNote(null);
    setPieces([]);
    setTitle("");
    setTitleNote(null);
    if (!file) return;
    if (isHeicFile(file)) {
      setError("HEIC 사진은 아직 읽지 못합니다. JPG/PNG로 저장해 다시 올려주세요.");
      return;
    }
    setPageFile(file);
    try {
      setPageImage(await fileToDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 읽지 못했습니다.");
    }
  }

  /** 자를 재료. 원본이 있으면 원본에서 잘라야 조각이 흐려지지 않는다. */
  async function openSource(): Promise<{ img: HTMLImageElement; revoke: () => void }> {
    if (pageFile) {
      const url = URL.createObjectURL(pageFile);
      try {
        return { img: await loadImage(url), revoke: () => URL.revokeObjectURL(url) };
      } catch {
        URL.revokeObjectURL(url);
      }
    }
    if (!pageImage) throw new Error("사진을 먼저 골라주세요.");
    return { img: await loadImage(pageImage), revoke: () => {} };
  }

  function cutBox(img: HTMLImageElement, b: ProblemBox, pad: number): string {
    const x = Math.max(0, b.x - pad) * img.naturalWidth;
    const y = Math.max(0, b.y - pad) * img.naturalHeight;
    const w = Math.min(1 - b.x + pad, b.w + pad * 2) * img.naturalWidth;
    const h = Math.min(1 - b.y + pad, b.h + pad * 2) * img.naturalHeight;
    return cropImageToDataUrl(
      img,
      { x, y, width: w, height: h },
      { maxWidth: PROBLEM_INPUT_DIM, maxHeight: PROBLEM_MAX_HEIGHT },
    );
  }

  /**
   * 영역을 찾을 때 보낼 이미지. **원본에서 만들되 요청 상한에 맞춰 줄인다**
   * (Vercel 4.5MB). 배치 패널과 같은 방식이다.
   */
  async function detectImage(img: HTMLImageElement): Promise<string> {
    const whole = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    let last = "";
    for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
      last = cropImageToDataUrl(img, whole, { maxWidth: dim, maxHeight: dim });
      if (last.length <= MAX_UPLOAD_CHARS) break;
    }
    const enhanced = await enhanceContrast(last);
    return enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : last;
  }

  /** 0단계 — 지문 글자를 읽어 제목을 짓는다. 실패해도 진행을 막지 않는다. */
  async function makeTitle(passageCrop: string) {
    setTitleNote("제목을 짓는 중...");
    try {
      const ocr = await fetch("/api/mathpix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: await enhanceContrast(passageCrop) }),
      });
      const read = (await ocr.json()) as { text?: string; latex?: string; error?: string };
      if (!ocr.ok) throw new Error(read.error ?? "지문을 읽지 못했습니다.");
      const text = (read.text || read.latex || "").trim();
      if (text.length < 20) throw new Error("지문 글자가 거의 인식되지 않았습니다.");

      const res = await fetch("/api/korean-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = (await res.json()) as { title?: string; kind?: string; error?: string };
      if (!res.ok || !json.title) throw new Error(json.error ?? "제목을 짓지 못했습니다.");
      setTitle(json.title);
      setTitleNote(`${json.kind ?? ""} 지문으로 보고 제목을 지었어요. 고쳐도 됩니다.`);
    } catch (err) {
      // 제목이 없어도 넣을 수는 있어야 한다. 사용자가 직접 적으면 된다.
      setTitleNote(
        (err instanceof Error ? err.message : "제목을 짓지 못했습니다.") +
          " 제목은 직접 적어주세요.",
      );
    }
  }

  /** 1·2단계 — 지문과 문제 영역을 한 번에 찾아 자른다. */
  async function detect() {
    if (!pageImage) return;
    setError(null);
    setNote(null);
    setBusy("사진을 여는 중...");

    let source: { img: HTMLImageElement; revoke: () => void };
    try {
      source = await openSource();
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
      setBusy(null);
      return;
    }

    try {
      // 영역 찾기와 자르기의 오류를 갈라 놓는다 — 한 덩어리로 감싸면 자르다
      // 난 오류까지 "인식 실패"로 보여서 어디가 잘못됐는지 알 수 없다.
      let found: DetectedKoreanRegion[];
      try {
        setBusy("지문과 문제 영역을 찾는 중...");
        const res = await fetch("/api/detect-problems", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: await detectImage(source.img), mode: "korean" }),
        });
        const json = (await res.json()) as { regions?: DetectedKoreanRegion[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "영역 인식에 실패했습니다.");
        found = json.regions ?? [];
      } catch (err) {
        setError(err instanceof Error ? err.message : "영역 인식에 실패했습니다.");
        return;
      }

      setBusy(`${found.length}개를 자르는 중...`);
      // 읽는 차례로 정렬한다 — 모델이 순서를 지키지 않는 경우가 있는데,
      // 자른 차례가 곧 문제 차례다. 지문을 늘 앞에 둔다.
      const sorted = [...found].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "passage" ? -1 : 1;
        const col = (r: DetectedKoreanRegion) => (r.box.x + r.box.w / 2 < 0.5 ? 0 : 1);
        return col(a) - col(b) || a.box.y - b.box.y;
      });
      const cut: Piece[] = sorted.map((r) => ({
        id: crypto.randomUUID(),
        kind: r.kind,
        crop: cutBox(source.img, r.box, PAD),
        box: r.box,
        no: r.no,
      }));
      setPieces(cut);

      const passage = cut.find((p) => p.kind === "passage");
      if (passage && !noPassage) void makeTitle(passage.crop);
      else if (!passage) setTitleNote("지문을 찾지 못했어요. 지문 없는 문항이면 아래를 체크하세요.");
    } catch (err) {
      setError(
        "영역은 찾았는데 사진을 자르지 못했습니다: " +
          (err instanceof Error ? err.message : "알 수 없는 오류"),
      );
    } finally {
      source.revoke();
      setBusy(null);
    }
  }

  /** 조각 하나를 카드 PNG 로 만든다(그림 한 장이 곧 카드다). */
  async function toCard(piece: Piece) {
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
    return { figure, pngDataUrl };
  }

  /**
   * 3단계 — 저장한다. `regenerate` 면 AI 재생성 큐에도 넣는다.
   *
   * **저장을 먼저 한다.** 그래야 행 id 를 큐에 함께 넘길 수 있고, 브라우저를
   * 닫아도 서버가 결과를 그 행에 직접 저장한다(`persistWholeProblem`).
   */
  async function save(regenerate: boolean) {
    if (pieces.length === 0) return;
    setError(null);
    setNote(null);
    // 한 지면이 곧 한 세트다. 지문 없는 문항이면 세트를 만들지 않는다.
    const setId = crypto.randomUUID();
    let done = 0;
    let qIndex = 0;

    for (const piece of pieces) {
      setBusy(`넣는 중... (${done + 1}/${pieces.length})`);
      try {
        const { figure, pngDataUrl } = await toCard(piece);
        const korean = noPassage
          ? undefined
          : piece.kind === "passage"
            ? { setId, role: "passage" as const, ...(title.trim() ? { title: title.trim() } : {}) }
            : { setId, role: "question" as const, index: qIndex };
        if (!noPassage && piece.kind === "question") qIndex += 1;

        const problemId = await onSave({
          pngDataUrl,
          text: "",
          answer: "",
          answerType: "choice",
          boxRange: {
            ranges: null,
            fontPt: DEFAULT_FONT_PT,
            figures: toStoredFigures([figure]),
            ...(piece.no != null ? { number: piece.no } : {}),
            ...(korean ? { korean } : {}),
          } as StoredBoxRange,
        });

        if (regenerate) {
          enqueue({
            id: piece.id,
            problemKey: `korean:${problemId}`,
            label: piece.kind === "passage" ? "지문" : `${piece.no ?? done + 1}번 문제`,
            crop: piece.crop,
            mode: "problem",
            problemId,
          });
        }
        done += 1;
      } catch (err) {
        setError(
          `${done + 1}번째에서 멈췄습니다: ` +
            (err instanceof Error ? err.message : "알 수 없는 오류"),
        );
        break;
      }
    }

    setBusy(null);
    if (done > 0) {
      setNote(
        regenerate
          ? `${done}개를 넣고 AI 재생성 큐에 올렸어요. 진행 상황은 화면 구석에서 볼 수 있어요.`
          : `${done}개를 원본 그대로 넣었어요.`,
      );
      reset();
      onDone?.();
    }
  }

  const passages = pieces.filter((p) => p.kind === "passage").length;
  const questions = pieces.length - passages;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">국어 모드 (지문 + 문항 세트)</h3>
        <p className="mt-1 text-xs text-slate-400">
          지문 한 편과 거기 딸린 문항들을 한 번에 넣습니다. 인쇄할 때 짝수 쪽에
          지문, 홀수 쪽에 그 문제들이 나란히 놓입니다.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
        className="text-sm"
      />

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={noPassage}
          onChange={(e) => setNoPassage(e.target.checked)}
          className="h-4 w-4"
        />
        지문 없는 문항
        <span className="text-xs text-slate-400">
          어휘·문법 단독 문항처럼 지문이 없으면 켜세요. 세트를 만들지 않고 보통
          문제로 넣습니다.
        </span>
      </label>

      {pageImage && pieces.length === 0 && (
        <div className="flex flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pageImage}
            alt="지면"
            className="max-h-80 w-full rounded border border-slate-200 object-contain"
          />
          <button
            type="button"
            onClick={() => void detect()}
            disabled={busy !== null}
            className="self-start rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ?? "지문·문제 영역 찾기"}
          </button>
          {!unlimited && (
            <p className="text-xs text-amber-700">
              자동 영역 찾기는 무제한 계정에서만 쓸 수 있습니다. 그 전에는 지면
              통째로 넣기에서 손으로 네모를 그려 넣어주세요.
            </p>
          )}
        </div>
      )}

      {pieces.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            지문 {passages}개 · 문제 {questions}개를 찾았어요. 잘못 잡힌 것은
            지우고, 지문/문제가 뒤바뀐 것은 눌러서 바꾸세요.
          </p>

          {!noPassage && (
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              지문 제목 (첫 장 목차에 적힙니다)
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 이중차분법"
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
              {titleNote && <span className="text-xs text-slate-400">{titleNote}</span>}
            </label>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {pieces.map((p) => (
              <div
                key={p.id}
                className={`relative rounded border p-1 ${
                  p.kind === "passage" ? "border-emerald-400 bg-emerald-50" : "border-slate-200"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.crop} alt="" className="h-32 w-full object-contain" />
                <div className="mt-1 flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setPieces((prev) =>
                        prev.map((q) =>
                          q.id === p.id
                            ? { ...q, kind: q.kind === "passage" ? "question" : "passage" }
                            : q,
                        ),
                      )
                    }
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
                  >
                    {p.kind === "passage" ? "지문" : `문제${p.no ? ` ${p.no}` : ""}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPieces((prev) => prev.filter((q) => q.id !== p.id))}
                    className="rounded px-1 text-xs text-slate-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save(false)}
              disabled={busy !== null}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ?? "원본 그대로 넣기"}
            </button>
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={busy !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ?? "모두 AI로 다시 그리기"}
              {typeof figureCost === "number" &&
                ` (약 ${figureCost * pieces.length}토큰)`}
            </button>
          </div>
        </div>
      )}

      {note && <p className="text-sm text-emerald-700">{note}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
