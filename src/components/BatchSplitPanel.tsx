"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cropImageToDataUrl, fileToDataUrl, isHeicFile, loadImage } from "@/lib/cropImage";
import {
  DETECT_INPUT_DIM,
  MAX_UPLOAD_CHARS,
  PROBLEM_INPUT_DIM,
  PROBLEM_MAX_HEIGHT,
  rasterToSvg,
  stitchVertically,
} from "@/lib/figureImage";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { toStoredFigures, type StoredBoxRange } from "@/lib/storedFigures";
import type { CardFigure } from "@/lib/cardHtml";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import type { DiagramLayout } from "@/lib/diagramLayout";
import type { DetectedProblem } from "@/lib/detectProblems";
import { enhanceContrast } from "@/lib/autoContrast";
import { useFigureJobs } from "./FigureJobsProvider";

/**
 * 지면 한 장을 문제 여러 개로 잘라 한꺼번에 넣는 패널.
 *
 * 자리를 정하는 방법이 **두 가지**다:
 *
 *  1. **손으로 네모 그리기 — 누구나 쓴다.** 사진 위에 문제마다 네모를 끌어
 *     그리면 그 자리대로 자른다. 모델을 부르지 않으므로 공짜고, 자리를
 *     사람이 정하니 틀릴 일도 없다.
 *  2. **자동으로 찾기 — 무제한 계정 전용.** Gemini 가 문제마다의 영역을 찾아
 *     준다(단을 넘어 이어진 문제까지 이어 붙인다). 편하지만 유료 호출이고,
 *     막는 자리는 서버다(`entitlements.unlimited`) — 화면은 얼마든지 우회할
 *     수 있다.
 *
 * 어느 쪽으로 잘랐든 그다음은 같다. 잘린 것을 눈으로 보고 잘못된 것을 지운 뒤
 * "모두 AI로 재생성"을 누르면 전부 **문제 전체 다시 그리기** 큐에 들어가 한
 * 개씩 순서대로 처리된다.
 *
 * 자르기와 다시 그리기를 나눠 둔 이유: 자르는 건 (손으로 하면) 공짜지만 다시
 * 그리기는 문제마다 1분쯤 걸리는 유료 호출이다. 먼저 보고 거른 다음 돌리는
 * 편이 안전하다.
 */

/** 통째로 그린 문제 이미지의 배치(AddProblemFlow와 같은 값). */
const WHOLE_PROBLEM_LAYOUT: DiagramLayout = { scale: 100, offsetX: 0, offsetY: 0 };

/**
 * 자동으로 찾은 영역을 자를 때 사방으로 더 주는 여유(지면 크기 대비 비율).
 *
 * **아주 조금만 준다.** 여백이 넓으면 문제 사이의 빈 줄까지 딸려 들어와
 * 문제지에 앉혔을 때 헐렁해 보인다. 글자가 한 획 잘리는 것만 막을 정도다.
 *
 * **손으로 그린 네모에는 주지 않는다.** 그건 사용자가 정한 자리라 우리가 몰래
 * 넓히면 보이는 것과 잘리는 것이 달라진다.
 */
const PAD = 0.004;

/** 이보다 작은 네모는 그리다 만 것으로 본다(지면 크기 대비 비율). */
const MIN_BOX = 0.02;

/** `parts` 가 2 이상이면 단을 넘어 이어진 문제를 이어 붙인 것이다. */
type Piece = { id: string; crop: string; parts: number };

/** 손으로 그린 네모. 값은 전부 지면 크기 대비 비율(0~1)이다. */
type Box = { id: string; x: number; y: number; w: number; h: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type Props = {
  /** 문제 하나를 저장하고 그 행 id를 돌려준다(AddProblemFlow가 준다). */
  onSave: (args: {
    pngDataUrl: string;
    text: string;
    answer: string;
    answerType: "choice";
    boxRange: StoredBoxRange;
  }) => Promise<string>;
  /** 자동 영역 찾기(Gemini)를 보여줄지. 서버에서도 같은 조건으로 막는다. */
  unlimited?: boolean;
  /** 문제 하나를 다시 그리는 데 드는 토큰. 서버가 알려준 값을 그대로 쓴다. */
  figureCost?: number | null;
};

export default function BatchSplitPanel({ onSave, unlimited = false, figureCost }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * 고른 사진 **원본**. 자르는 재료는 이것이다.
   *
   * `fileToDataUrl` 로 만든 축소본(긴 변 1600px)에서 자르면, 지면 한 장이
   * 1600px 인데 문제 하나는 그 4분의 1쯤이라 **폭 450px 짜리 조각**이 나온다.
   * 그걸 그대로 모델에 보내면 본문 글자가 뭉개져서 못 읽는다(손으로 한 문제만
   * 찍었을 때는 1200~1600px 이 나가던 자리다). 그래서 화면에는 축소본을 쓰고
   * **자르기는 원본에서** 한다.
   */
  const [pageFile, setPageFile] = useState<File | null>(null);
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 어떤 모델이 영역을 잡았는지. 모델을 바꿔 가며 견줄 때 필요하다. */
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const { enqueue } = useFigureJobs();

  /** 그리는 중인 네모. 손을 뗄 때 boxes 로 옮긴다. */
  const [draft, setDraft] = useState<Box | null>(null);
  /**
   * 그리는 중인 네모의 **최신 값**. 손을 뗄 때 이걸 읽는다.
   *
   * state 갱신 함수 안에서 다른 state 를 바꾸면 안 된다 — 갱신 함수는 순수해야
   * 하고 React 가 두 번 부를 수 있다. 실제로 `setDraft(d => { setBoxes(...) })`
   * 로 썼다가 **끌기 한 번에 네모가 두 개** 생겼다(브라우저로 확인했다).
   */
  const draftRef = useRef<Box | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  /** 끌기 시작한 자리(비율). 그리는 중이 아니면 null. */
  const startRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * 화면 좌표를 사진 안의 비율로 바꾼다.
   *
   * 사진은 화면 폭에 맞춰 줄여 그리므로 화면 픽셀과 사진 픽셀이 다르다. 비율로
   * 들고 있으면 화면 크기가 바뀌어도, 자를 때 원본 해상도로 되돌려도 그대로
   * 맞는다.
   */
  const ratio = useCallback((clientX: number, clientY: number) => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: clamp01((clientX - r.left) / r.width),
      y: clamp01((clientY - r.top) / r.height),
    };
  }, []);

  /**
   * 끌기는 **window 에서 받는다**(setPointerCapture 가 아니라).
   *
   * 그리는 중에 네모가 바뀌면서 화면이 다시 그려지는데, 그때 처음 잡았던 DOM
   * 노드가 떨어져 나가면 포인터 캡처가 조용히 풀린다. 사진 **바깥**에서 손을
   * 놓는 일도 흔하다(가장자리 문제를 그릴 때가 그렇다) — 그때 pointerup 이
   * 아무 데도 닿지 않으면 그린 게 통째로 사라진다.
   *
   * 이 두 함수는 ref 와 setState 만 쓰므로 렌더가 바뀌어도 그대로다. 그래서
   * 참조가 안정적이고 그냥 붙였다 뗄 수 있다.
   */
  const onMove = useCallback(
    (e: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const now = ratio(e.clientX, e.clientY);
      if (!now) return;
      const next: Box = {
        id: "draft",
        x: Math.min(start.x, now.x),
        y: Math.min(start.y, now.y),
        w: Math.abs(now.x - start.x),
        h: Math.abs(now.y - start.y),
      };
      draftRef.current = next;
      setDraft(next);
    },
    [ratio],
  );

  const onUp = useCallback(() => {
    if (!startRef.current) return;
    startRef.current = null;
    const d = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    // 너무 작으면 그리다 만 것(또는 그냥 톡 누른 것)으로 보고 버린다.
    if (d && d.w >= MIN_BOX && d.h >= MIN_BOX) {
      setBoxes((prev) => [...prev, { ...d, id: crypto.randomUUID() }]);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onMove, onUp]);

  function startDraw(e: React.PointerEvent) {
    if (busy) return;
    const at = ratio(e.clientX, e.clientY);
    if (!at) return;
    startRef.current = at;
    const seed: Box = { id: "draft", x: at.x, y: at.y, w: 0, h: 0 };
    draftRef.current = seed;
    setDraft(seed);
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPieces([]);
    setBoxes([]);
    setUsedModel(null);
    if (isHeicFile(file)) {
      setError("HEIC 사진은 아직 지원하지 않습니다. JPG나 PNG로 바꿔 올려주세요.");
      return;
    }
    try {
      // 화면 표시·영역 감지에는 축소본이면 충분하다(자르기는 원본에서 한다).
      setPageImage(await fileToDataUrl(file));
      setPageFile(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 불러오지 못했습니다.");
    }
  }

  /**
   * 자를 재료가 될 이미지를 연다.
   *
   * **원본에서 자른다** — 화면용 축소본(긴 변 1600px)에서 자르면 지면 한 장이
   * 1600px 인데 문제 하나는 그 4분의 1쯤이라 폭 450px 짜리 조각이 나오고,
   * 그러면 모델이 본문을 못 읽는다. 원본은 data URL 로 만들지 않고
   * `createObjectURL` 로 읽는다(카메라 사진을 통째로 문자열로 바꾸면 수십 MB가
   * 되어 일부 브라우저에서 터진다).
   *
   * 원본을 못 여는 경우에는 **축소본으로라도 자른다.** 흐릴지언정 아무것도
   * 못 하는 것보다는 낫다.
   */
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

  /**
   * 비율로 적힌 자리 하나를 원본에서 잘라낸다.
   *
   * 폭을 지켜서 자른다 — 긴 변 기준으로 줄이면 세로로 긴 문제의 폭이 무너져
   * 본문 글자가 뭉개진다.
   */
  function cutBox(
    img: HTMLImageElement,
    b: { x: number; y: number; w: number; h: number },
    pad: number,
  ): string {
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
   * 손으로 그린 네모대로 자른다. **그린 차례가 곧 문제 차례다** — 사람은
   * 읽는 순서대로 그리므로 우리가 다시 정렬할 이유가 없다(자동으로 찾을
   * 때와 다른 점이다. 그쪽은 모델이 순서를 지키지 않아 우리가 정렬한다).
   */
  async function cutManual() {
    if (boxes.length === 0) return;
    setError(null);
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
      setBusy(`${boxes.length}개를 자르는 중...`);
      setPieces(
        boxes.map((b) => ({
          id: crypto.randomUUID(),
          crop: cutBox(source.img, b, 0),
          parts: 1,
        })),
      );
      setUsedModel(null);
    } catch (err) {
      setError(
        "사진을 자르지 못했습니다: " +
          (err instanceof Error ? err.message : "알 수 없는 오류"),
      );
    } finally {
      source.revoke();
      setBusy(null);
    }
  }

  /**
   * 영역을 찾을 때 보낼 이미지를 만든다. **원본에서 만든다.**
   *
   * 지면 한 장에 문제가 열 몇 개 들어 있으면 문제 하나는 화면의 몇 %밖에
   * 안 된다. 작게 보내면 경계를 대충 잡으므로 되도록 크게 보낸다.
   *
   * 다만 요청 본문에는 상한이 있어(Vercel 4.5MB) 넘으면 요청 자체가 실패한다 —
   * 그래서 실제 길이를 보고 들어갈 때까지 한 단씩 낮춘다.
   */
  async function detectImage(img: HTMLImageElement): Promise<string> {
    const whole = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    let last = "";
    for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
      last = cropImageToDataUrl(img, whole, { maxWidth: dim, maxHeight: dim });
      if (last.length <= MAX_UPLOAD_CHARS) break;
    }
    // 대비를 올리면 글자와 종이의 경계가 또렷해져 영역을 더 잘 잡는다.
    // 크기를 맞춘 **뒤에** 한다(전에 하면 늘린 값이 다시 뭉개진다).
    const enhanced = await enhanceContrast(last);
    return enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : last;
  }

  async function detect() {
    if (!pageImage) return;
    setBusy("사진을 여는 중...");
    setError(null);

    let source: { img: HTMLImageElement; revoke: () => void };
    try {
      source = await openSource();
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
      setBusy(null);
      return;
    }

    try {
      // 영역 찾기와 자르기를 나눠 둔다. 한 덩어리로 감싸면 자르다 난 오류까지
      // "문제 영역 인식 실패"로 보여서 어디가 잘못됐는지 알 수 없다.
      let found: DetectedProblem[];
      setBusy("문제 영역을 찾는 중...");
      try {
        const res = await fetch("/api/detect-problems", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: await detectImage(source.img) }),
        });
        const json: { problems?: DetectedProblem[]; model?: string; error?: string } =
          await res.json();
        if (!res.ok) throw new Error(json.error ?? "문제 영역 인식에 실패했습니다.");
        found = json.problems ?? [];
        setUsedModel(json.model ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "문제 영역 인식에 실패했습니다.");
        return;
      }
      if (found.length === 0) {
        setError("문제 영역을 찾지 못했습니다. 지면이 또렷하게 나온 사진으로 다시 해보세요.");
        setPieces([]);
        return;
      }

      setBusy(`영역 ${found.length}개를 자르는 중...`);
      try {
        const img = source.img;
        // 단을 넘어 이어진 문제는 조각을 **읽는 차례대로 세로로 이어 붙인다.**
        const next: Piece[] = await Promise.all(
          found.map(async (prob) => ({
            id: crypto.randomUUID(),
            crop: await stitchVertically(prob.boxes.map((b) => cutBox(img, b, PAD))),
            parts: prob.boxes.length,
          })),
        );
        setPieces(next);
        setBoxes([]);
      } catch (err) {
        setError(
          "영역은 찾았는데 사진을 자르지 못했습니다: " +
            (err instanceof Error ? err.message : "알 수 없는 오류"),
        );
      }
    } finally {
      source.revoke();
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
      setBoxes([]);
      setPageImage(null);
      setPageFile(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const totalCost =
    typeof figureCost === "number" ? figureCost * pieces.length : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-700">지면 통째로 넣기</span>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        문제가 여러 개 있는 지면을 올리고 <b>문제마다 네모를 끌어 그리면</b> 그
        자리대로 하나씩 잘라 줍니다. 잘린 것을 보고 잘못된 것을 지운 다음 “모두
        AI로 재생성”을 누르면 전부 큐에 들어가 한 개씩 다시 그려집니다.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="text-xs text-slate-600 file:mr-2 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:text-slate-700"
      />

      {pageImage && (
        <>
          <p className="text-[11px] text-slate-500">
            {boxes.length === 0
              ? "사진 위에서 손가락이나 마우스로 문제 하나를 감싸는 네모를 그리세요."
              : `${boxes.length}개를 그렸습니다. 이어서 더 그리거나, 네모의 × 로 지울 수 있어요.`}
          </p>
          <div
            ref={frameRef}
            onPointerDown={startDraw}
            /* 터치가 스크롤로 먹히지 않게 한다. 없으면 화면만 밀린다. */
            className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-slate-300 bg-white"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pageImage} alt="" draggable={false} className="w-full" />
            {[...boxes, ...(draft ? [draft] : [])].map((b, i) => (
              <div
                key={b.id}
                className={
                  "absolute border-2 " +
                  (b.id === "draft"
                    ? "border-dashed border-violet-400 bg-violet-400/10"
                    : "border-violet-600 bg-violet-600/10")
                }
                style={{
                  left: `${b.x * 100}%`,
                  top: `${b.y * 100}%`,
                  width: `${b.w * 100}%`,
                  height: `${b.h * 100}%`,
                }}
              >
                {b.id !== "draft" && (
                  <>
                    <span className="absolute left-0 top-0 bg-violet-600 px-1 text-[11px] leading-tight text-white">
                      {i + 1}
                    </span>
                    <button
                      type="button"
                      /* 여기서 pointerdown 을 멈추지 않으면 지우려고 누른 것이
                         새 네모를 그리기 시작한다. */
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setBoxes((prev) => prev.filter((x) => x.id !== b.id))}
                      aria-label={`${i + 1}번째 네모 지우기`}
                      className="absolute right-0 top-0 bg-violet-600 px-1 text-[11px] leading-tight text-white hover:bg-red-600"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {pageImage && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void cutManual()}
            disabled={busy !== null || boxes.length === 0}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            그린 자리대로 자르기{boxes.length > 0 && ` (${boxes.length}개)`}
          </button>
          {/* 자동으로 찾기는 유료 호출이라 무제한 계정에서만 보인다.
              막는 자리는 서버다 — 화면은 얼마든지 우회할 수 있다. */}
          {unlimited && (
            <button
              type="button"
              onClick={() => void detect()}
              disabled={busy !== null}
              className="rounded-lg border border-violet-300 bg-white px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
            >
              자동으로 찾기
            </button>
          )}
          {pieces.length > 0 && (
            <button
              type="button"
              onClick={() => void regenerateAll()}
              disabled={busy !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              모두 AI로 재생성 ({pieces.length}개
              {totalCost !== null && !unlimited && ` · ${totalCost}토큰`})
            </button>
          )}
        </div>
      )}

      {busy && <p className="text-xs text-slate-500">{busy}</p>}
      {!busy && usedModel && pieces.length > 0 && (
        <p className="text-[11px] text-slate-400">
          {usedModel} 로 {pieces.length}개를 잡았습니다
        </p>
      )}
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
