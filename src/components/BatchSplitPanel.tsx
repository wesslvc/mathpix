"use client";

import { useEffect, useRef, useState } from "react";
import {
  NO_CROP_LIMIT,
  cropImageToDataUrl,
  fileToDataUrl,
  isHeicFile,
  loadDrawableFromFile,
  openPageSource,
  type PageSource,
} from "@/lib/cropImage";
import { cropRegionToDataUrl, isRealPolygon, type Region } from "@/lib/polygon";
import { useCropShape } from "@/lib/cropShape";
import BoxEditor, { type EditBox } from "./BoxEditor";
import CropShapeToggle from "./CropShapeToggle";
import {
  DETECT_INPUT_DIM,
  MAX_UPLOAD_CHARS,
  stitchVertically,
} from "@/lib/figureImage";
import type { StoredBoxRange } from "@/lib/storedFigures";
import type { DetectedProblem } from "@/lib/detectProblems";
import { mergeChosen, type ProblemBox } from "@/lib/problemBoxes";
import { enhanceContrast } from "@/lib/autoContrast";
import { attachNumberAndAnswer, readNumberWithMathpix, wholeProblemCard } from "@/lib/quickProblem";
import { runAiTask } from "@/lib/aiTask";
import { inkMapFromImage, snapBoxes } from "@/lib/snapBoxes";
import { cutRefineWindows, refineProblems } from "@/lib/pageRefine";
import type { AnswerByNumber } from "@/lib/answerMap";
import { useFigureJobs } from "./FigureJobsProvider";
import { Button } from "@/components/ui/button";

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

/**
 * 잘린 문제 하나.
 *
 * `parts` 가 2 이상이면 단을 넘어 이어진 문제를 세로로 이어 붙인 것이다.
 *
 * **자른 자리(`boxes`)를 들고 있는 이유**: 나중에 조각 둘을 합칠 때 그림을
 * 이어 붙이는 게 아니라 **원본에서 다시 잘라야** 하기 때문이다. 같은 단에
 * 있던 것을 이어 붙이면 폭을 다시 맞추고 사이에 띠가 들어가 잘렸다 붙인
 * 티가 난다 — 자리를 알고 있으면 아우르는 네모 하나로 다시 자를 수 있다.
 */
/** luna 가 찾은 지면 자리. */
/** `refined` = 문제마다 확대해 다시 맞춘 수(`pageRefine.ts`). */
type Found = { problems: DetectedProblem[]; model: string | null; refined?: number };

type Piece = {
  id: string;
  crop: string;
  parts: number;
  /** 자른 자리. 손으로 그린 다각형이면 `poly` 가 붙어 있다(`polygon.ts`). */
  boxes: Region[];
  /** 자를 때 준 여유. 손으로 그린 것은 0, 자동으로 찾은 것은 PAD. */
  pad: number;
  /** luna 가 영역을 찾으며 읽은 문제 번호. 손으로 그린 조각에는 없다(그때만 Mathpix 로 읽는다). */
  no?: number;
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
  /** 자동 영역 찾기(luna)를 보여줄지. 서버에서도 같은 조건으로 막는다. */
  unlimited?: boolean;
  /**
   * BYOK 패스 계정인가. 본인 키로 직접 내므로 "모두 AI로 재생성"에 토큰
   * 비용을 붙여 보여주면 안 된다(실제로도 안 든다 — `/api/figure`가 건너뛴다).
   */
  byok?: boolean;
  /** 문제 하나를 다시 그리는 데 드는 토큰. 서버가 알려준 값을 그대로 쓴다. */
  figureCost?: number | null;
  /** 번호 → 정답. 번호를 읽으면 곧바로 정답도 붙인다(`answerMap.ts`). */
  answerByNumber?: AnswerByNumber;
};

export default function BatchSplitPanel({
  onSave,
  unlimited = false,
  byok = false,
  figureCost,
  answerByNumber = {},
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLInputElement>(null);
  /** 아직 안 연 다음 지면들과 처음 고른 장수(여러 장을 연달아 처리한다). */
  const [queue, setQueue] = useState<File[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  /** 뒤에서 도는 저장 줄. 한 번에 하나씩 이어 붙인다. */
  const bgRef = useRef<Promise<void>>(Promise.resolve());
  const [bg, setBg] = useState({ pending: 0, done: 0, numbered: 0, answered: 0 });
  const [failedItems, setFailedItems] = useState<
    { kind: "asis" | "ai"; piece: Piece; label: string; msg: string }[]
  >([]);
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
  const [boxes, setBoxes] = useState<EditBox[]>([]);
  /** 손으로 그릴 모양(사각형/다각형). 자르는 화면 어디서든 같은 기본값을 쓴다. */
  const [shape, setShape] = useCropShape();
  const [pieces, setPieces] = useState<Piece[]>([]);
  /** 합치려고 고른 조각들. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 어떤 모델이 영역을 잡았는지. 모델을 바꿔 가며 견줄 때 필요하다. */
  const [usedModel, setUsedModel] = useState<string | null>(null);
  /** 테두리를 사진의 글자에 맞춰 다듬은 네모 수(`snapBoxes.ts`). */
  const [snapped, setSnapped] = useState(0);
  /** 문제마다 확대해 luna 가 다시 맞춘 수. */
  const [refinedCount, setRefinedCount] = useState(0);
  const { enqueue } = useFigureJobs();
  /** 지금 자르는 재료의 크기와, 원본을 못 열어 축소본으로 내려갔는지. */
  const [sourceInfo, setSourceInfo] = useState<{ w: number; h: number; degraded: boolean } | null>(null);
  /** 조각마다 실제 픽셀 크기(그림이 뜨면 잰다). 흐린지 눈으로 짐작하지 말고 숫자로 본다. */
  const [pieceSizes, setPieceSizes] = useState<Record<string, string>>({});
  /**
   * **지면을 여러 장 고르면 luna 가 전부 한꺼번에 자리를 찾는다**(2026-10-04, 사용자 — "일괄로 업로드하면 luna 가 한 번에
   * 처리해서 … 지면도 마찬가지"). 고르는 순간 장마다 영역 찾기를 서버 대기열에 넣어 두고(줄이기·올리기만 한 장씩,
   * luna 호출은 동시에), 그 지면을 열 때 결과를 그대로 쓴다 — 넘기면 다음 지면은 이미 잘려 있다. 무제한 계정만(영역 찾기는
   * 무제한 전용이다).
   */
  const prefetchRef = useRef(new Map<File, Promise<Found>>());
  const prefetchChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 열자마자 자동으로 찾은 지면(같은 지면을 두 번 찾지 않게). */
  const autoDetectedRef = useRef<string | null>(null);
  /** 남은 지면도 같은 방식으로 한 번에 넣는다. */
  const [allRest, setAllRest] = useState(false);
  /** 한 번에 넣는 중인 남은 지면 수. */
  const [autoPages, setAutoPages] = useState(0);

  /**
   * 지면을 **여러 장** 고르면 첫 장부터 차례로 처리한다. 한 장을 넣고 나면(그대로 넣기·
   * AI 재생성) 곧바로 다음 지면이 열려 이어서 자를 수 있다 — AI 는 뒤에서 돌므로
   * 기다릴 것이 없다. 열지 못하는 사진(HEIC 등)은 건너뛰고 알린다.
   */
  // 뒤에서 저장 중일 때 탭을 닫으면 아직 안 넣은 조각이 사라진다 — 브라우저가 되묻게 한다.
  useEffect(() => {
    if (bg.pending === 0 && autoPages === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [bg.pending, autoPages]);

  async function pick(list: FileList | null | undefined) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    setError(null);
    setTotalPages(files.length);
    if (unlimited) files.forEach((f) => void prefetchDetect(f).catch(() => undefined));
    await loadFrom(files);
  }

  /** 대기열 끝에 지면을 더 붙인다(지금 지면이 없으면 그것부터 연다). */
  async function addMore(list: FileList | null | undefined) {
    const files = Array.from(list ?? []);
    if (moreRef.current) moreRef.current.value = "";
    if (files.length === 0) return;
    if (unlimited) files.forEach((f) => void prefetchDetect(f).catch(() => undefined));
    if (!pageImage) {
      setTotalPages(files.length);
      await loadFrom(files);
      return;
    }
    setQueue((q) => [...q, ...files]);
    setTotalPages((t) => t + files.length);
  }

  /** 이 목록의 첫 번째로 열리는 사진을 지금 지면으로 삼고 나머지는 대기열에 둔다. */
  async function loadFrom(files: File[]) {
    setBusy("지면을 여는 중...");
    const skipped: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (isHeicFile(file)) {
          skipped.push(`${file.name}(HEIC)`);
          continue;
        }
        try {
          // 화면 표시·영역 감지에는 축소본이면 충분하다(자르기는 원본에서 한다).
          const url = await fileToDataUrl(file);
          setPieces([]);
          setPicked(new Set());
          setBoxes([]);
          setUsedModel(null);
          setSourceInfo(null);
          setPageImage(url);
          setPageFile(file);
          setQueue(files.slice(i + 1));
          setError(skipped.length ? `열지 못해 건너뛴 사진: ${skipped.join(", ")}` : null);
          return;
        } catch {
          skipped.push(file.name);
        }
      }
      // 하나도 못 열었다.
      setPieces([]);
      setPicked(new Set());
      setBoxes([]);
      setPageImage(null);
      setPageFile(null);
      setQueue([]);
      setError(
        skipped.length
          ? `사진을 열지 못했습니다: ${skipped.join(", ")}. HEIC 는 JPG 로 바꾸고, 안 열리는 사진은 캡처하거나 갤러리에서 다시 저장해 올려주세요.`
          : null,
      );
    } finally {
      setBusy(null);
    }
  }

  /** 지금 지면을 끝냈다(또는 건너뛴다) — 다음 지면이 있으면 이어서 연다. */
  function nextPage(stop = false) {
    setPieces([]);
    setPicked(new Set());
    setBoxes([]);
    setUsedModel(null);
    if (!stop && queue.length > 0) {
      void loadFrom(queue);
      return;
    }
    setPageImage(null);
    setPageFile(null);
    setQueue([]);
    setTotalPages(0);
    if (fileRef.current) fileRef.current.value = "";
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
  async function openSource(): Promise<PageSource> {
    if (!pageImage) throw new Error("사진을 먼저 골라주세요.");
    const s = await openPageSource(pageFile, pageImage);
    // 어느 크기의 사진에서 잘랐는지, 축소본으로 내려갔는지를 화면에 남긴다.
    setSourceInfo({ w: s.width, h: s.height, degraded: s.degraded });
    return s;
  }

  /**
   * 비율로 적힌 자리 하나를 원본에서 잘라낸다.
   *
   * 폭을 지켜서 자른다 — 긴 변 기준으로 줄이면 세로로 긴 문제의 폭이 무너져
   * 본문 글자가 뭉개진다.
   */
  function cutBox(img: HTMLImageElement | ImageBitmap, b: Region, pad: number): string {
    // 다각형이면 바깥을 흰색으로 지우고 자른다(`polygon.ts`).
    return cropRegionToDataUrl(img, b, pad, NO_CROP_LIMIT);
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
    let source: PageSource;
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
          boxes: [{ x: b.x, y: b.y, w: b.w, h: b.h, ...(b.poly ? { poly: b.poly } : {}) }],
          pad: 0,
        })),
      );
      setPicked(new Set());
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
  async function detectImage(src: PageSource): Promise<string> {
    const img = src.img;
    const whole = { x: 0, y: 0, width: src.width, height: src.height };
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

  /** 지면 한 장의 영역 찾기를 서버 대기열에 넣는다(이미 넣었으면 그것). 원본을 못 열면 실패 — 지면을 열 때 다시 찾는다. */
  function prefetchDetect(file: File): Promise<Found> {
    const had = prefetchRef.current.get(file);
    if (had) return had;
    const promise = new Promise<Found>((resolve, reject) => {
      const run = async () => {
        try {
          const d = await loadDrawableFromFile(file);
          let image: string;
          try {
            image = await detectImage({ img: d.src as HTMLImageElement | ImageBitmap, width: d.width, height: d.height, degraded: false, revoke: d.close });
          } finally {
            d.close();
          }
          let queued = () => {};
          const inLine = new Promise<void>((r) => (queued = r));
          void askDetect(image, `지면 자리 찾기 · ${file.name}`, () => queued())
            .then((got) => refineWithFile(file, got))
            .then(resolve, reject)
            .finally(() => queued());
          await inLine;
        } catch (err) {
          reject(err);
        }
      };
      prefetchChainRef.current = prefetchChainRef.current.then(run, run);
    });
    promise.catch(() => undefined);
    prefetchRef.current.set(file, promise);
    return promise;
  }

  /**
   * 찾은 자리를 **문제마다 확대해 다시 맞춘다**(`pageRefine.ts`). 창을 오리려면 원본을 다시 열어야 해서 여는 일만 한 장씩
   * 잇고(메모리), luna 호출은 문제마다 동시에 돈다. 못 하면 찾은 자리 그대로.
   */
  async function refineWithFile(file: File, got: Found): Promise<Found> {
    if (got.problems.length === 0) return got;
    let windows: ReturnType<typeof cutRefineWindows> = [];
    const cut = async () => {
      const d = await loadDrawableFromFile(file);
      try {
        windows = cutRefineWindows(d.src as CanvasImageSource, d.width, d.height, got.problems);
      } finally {
        d.close();
      }
    };
    const step = prefetchChainRef.current.then(cut, cut);
    prefetchChainRef.current = step.catch(() => undefined);
    try {
      await step;
    } catch {
      return got;
    }
    if (windows.length === 0) return got;
    const r = await refineProblems(got.problems, windows, `지면 · ${file.name}`);
    return { ...got, problems: r.problems, refined: r.refined };
  }

  async function askDetect(image: string, label: string, onQueued?: () => void): Promise<Found> {
    // **서버 대기열에서 찾는다**(`runAiTask` — 대기열 패널에 뜬다).
    const { result } = await runAiTask<{ problems?: DetectedProblem[]; model?: string }>("detect", {
      label,
      images: [image],
      params: { mode: "pages" },
      onQueued,
    });
    return { problems: result.problems ?? [], model: result.model ?? null };
  }

  /**
   * 찾은 자리로 조각을 만든다 — **테두리는 사진이 정한다**(`snapBoxes.ts`). 모델은 어느 문제가 어디쯤인지는 잘 알지만
   * 테두리가 1~2% 어긋난다(지면을 줄여 본다). 변마다 가까운 흰 띠에 붙여 잘린 줄·남는 여백을 없앤다. 못 하면 그대로 간다.
   * 단을 넘어 이어진 문제는 조각을 **읽는 차례대로 세로로 이어 붙인다.**
   */
  async function piecesFrom(source: PageSource, problems: DetectedProblem[]): Promise<{ pieces: Piece[]; snapped: number }> {
    let found = problems;
    const map = inkMapFromImage(source.img, source.width, source.height);
    let snappedCount = 0;
    if (map) {
      const res = snapBoxes(map, found.flatMap((p) => p.boxes));
      snappedCount = res.changed;
      let k = 0;
      // 확대해 다시 맞출 때 luna 가 짚은 번호·선지(`keep`)는 글자에 맞춰 다듬은 뒤에도 반드시 품는다(자동 자르기와 같은 규칙) —
      // 다듬기가 끝 선지 줄을 "이웃 것"으로 보고 잘라 내는 일이 있었다.
      found = found.map((p) => ({ ...p, boxes: p.boxes.map((orig) => withKeep(res.boxes[k++], orig)) }));
    }
    const img = source.img;
    const pieces: Piece[] = await Promise.all(
      found.map(async (prob) => ({
        id: crypto.randomUUID(),
        crop: await stitchVertically(prob.boxes.map((b) => cutBox(img, b, PAD))),
        parts: prob.boxes.length,
        boxes: prob.boxes,
        pad: PAD,
        no: prob.no && Number(prob.no) > 0 ? Number(prob.no) : undefined,
      })),
    );
    return { pieces, snapped: snappedCount };
  }

  async function detect() {
    if (!pageImage) return;
    setBusy("사진을 여는 중...");
    setError(null);

    let source: PageSource;
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
      setBusy("luna 가 문제 영역을 찾는 중...");
      try {
        // 고를 때 미리 넣어 둔 것이 있으면 그 결과를 기다린다(대개 이미 끝나 있다). 미리 못 찾았으면 지금 찾는다.
        const pre = pageFile ? prefetchRef.current.get(pageFile) : undefined;
        let got: Found | null = null;
        if (pre) got = await pre.catch(() => null);
        if (!got) {
          got = await askDetect(await detectImage(source), "지면에서 문제 자리 찾기");
          if (got.problems.length > 0) {
            setBusy("luna 가 문제마다 확대해 테두리를 다시 맞추는 중...");
            const windows = cutRefineWindows(source.img, source.width, source.height, got.problems);
            const r = await refineProblems(got.problems, windows, "지면");
            got = { ...got, problems: r.problems, refined: r.refined };
          }
        }
        setRefinedCount(got.refined ?? 0);
        found = got.problems;
        setUsedModel(got.model);
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
        const { pieces: next, snapped: n } = await piecesFrom(source, found);
        setSnapped(n);
        setPieces(next);
        setPicked(new Set());
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

  // 무제한 계정은 지면을 열자마자 luna 가 찾은 자리로 자른다 — 누를 것 없이 확인하고 넘기기만 하면 된다.
  useEffect(() => {
    if (!unlimited || !pageImage || pieces.length > 0 || boxes.length > 0) return;
    if (autoDetectedRef.current === pageImage) return;
    autoDetectedRef.current = pageImage;
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageImage]);

  /**
   * **남은 지면을 한 번에 넣는다**(사용자 — "손이 안 가게"). 지면마다 luna 가 찾은 자리(미리 넣어 둔 것)로 잘라 같은 방식으로
   * 저장 줄에 넣는다. 화면은 곧바로 비워지고 뒤에서 돈다. 못 찾은 지면은 건너뛰고 알린다(손으로 다시 올리면 된다).
   */
  async function processRestPages(kind: "asis" | "ai", files: File[], firstPageNo: number) {
    setAutoPages(files.length);
    const failed: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const pageTag = `지면 ${firstPageNo + i} · `;
      try {
        if (isHeicFile(file)) throw new Error("HEIC");
        const got = await prefetchDetect(file);
        if (got.problems.length === 0) throw new Error("문제 자리를 못 찾음");
        const d = await loadDrawableFromFile(file);
        let made: Piece[];
        try {
          made = (await piecesFrom({ img: d.src as HTMLImageElement | ImageBitmap, width: d.width, height: d.height, degraded: false, revoke: d.close }, got.problems)).pieces;
        } finally {
          d.close();
        }
        setBg((b) => ({ ...b, pending: b.pending + made.length }));
        bgRef.current = bgRef.current.then(() => runBatch(kind, made, pageTag)).catch(() => undefined);
      } catch (err) {
        failed.push(`${file.name}(${err instanceof Error ? err.message : "실패"})`);
      }
      setAutoPages((n) => Math.max(0, n - 1));
    }
    if (failed.length) setError(`자동으로 넣지 못한 지면: ${failed.join(", ")} — 다시 올려 손으로 자르거나 다시 찾아 주세요.`);
  }

  /**
   * 고른 조각들을 **한 문제로 합친다.**
   *
   * 자동으로 찾은 결과가 한 문제를 둘로 쪼개 놓는 일이 있다(발문과 선지가
   * 따로 잡히거나, 단을 넘어간 문제를 못 묶거나). 손으로 그릴 때도 나눠
   * 그렸다가 합치고 싶을 수 있다. 그때 이걸로 붙인다.
   *
   * **그림을 이어 붙이는 게 아니라 원본에서 다시 자른다.** 그래서 조각마다
   * 자른 자리를 들고 있었다. 같은 단에서 **붙어 있던** 것은 아우르는 네모
   * 하나로 다시 잘려 이음매가 없고, 단을 넘어갔거나 멀리 떨어진 것은 세로로
   * 이어 붙는다(`mergeChosen`).
   *
   * **멀리 떨어진 것을 아우르면 안 된다** — 사이에 있던 다른 문제까지 딸려
   * 들어와 지면이 통째로 한 조각이 되고, 그 문제는 목록에도 따로 남아 두 번
   * 나온다. 실제로 그렇게 됐다.
   *
   * 합친 것은 **고른 것들 중 가장 앞자리**에 놓는다. 문제 차례가 유지된다.
   */
  async function mergeSelected() {
    const chosen = pieces.filter((p) => picked.has(p.id));
    if (chosen.length < 2) return;
    setError(null);
    setBusy("사진을 여는 중...");

    let source: PageSource;
    try {
      source = await openSource();
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : "사진을 열지 못했습니다.") +
          " 합치려면 지면 사진이 그대로 있어야 합니다.",
      );
      setBusy(null);
      return;
    }

    try {
      setBusy(`${chosen.length}개를 합치는 중...`);
      const all = chosen.flatMap((p) => p.boxes);
      // 여유는 가장 큰 것에 맞춘다. 손으로 그린 것(0)과 자동으로 찾은 것(PAD)이
      // 섞일 수 있는데, 좁은 쪽에 맞추면 자동으로 찾은 쪽 글자가 잘릴 수 있다.
      const pad = Math.max(...chosen.map((p) => p.pad));
      // 다각형은 네모로 아우를 수 없다(아우르는 순간 지운 바깥이 되살아난다) —
      // 하나라도 섞여 있으면 아우르지 않고 읽는 차례대로 이어 붙인다.
      const merged: Region[] = all.some(isRealPolygon)
        ? [...all].sort((a, b) => (a.x + a.w / 2 < 0.5 ? 0 : 1) - (b.x + b.w / 2 < 0.5 ? 0 : 1) || a.y - b.y)
        : mergeChosen(all);
      const crop = await stitchVertically(
        merged.map((b) => cutBox(source.img, b, pad)),
      );
      const at = pieces.findIndex((p) => picked.has(p.id));
      const next: Piece = {
        id: crypto.randomUUID(),
        crop,
        parts: merged.length,
        boxes: merged,
        pad,
        // 합친 것은 가장 앞 조각의 번호를 쓴다(합친 것이 곧 그 문제다).
        no: chosen.find((p) => p.no != null)?.no,
      };
      setPieces((prev) => {
        const rest = prev.filter((p) => !picked.has(p.id));
        // 없앤 것들 중 가장 앞자리를 셈해 그 자리에 끼운다.
        const before = prev.slice(0, at).filter((p) => !picked.has(p.id)).length;
        return [...rest.slice(0, before), next, ...rest.slice(before)];
      });
      setPicked(new Set());
    } catch (err) {
      setError(
        "합치지 못했습니다: " +
          (err instanceof Error ? err.message : "알 수 없는 오류"),
      );
    } finally {
      source.revoke();
      setBusy(null);
    }
  }

  /**
   * 잘린 것들을 **뒤에서** 저장하고 곧바로 다음 지면으로 넘어간다.
   *
   * 예전에는 저장이 끝날 때까지 화면이 잠겨(`busy`) 다음 지면을 자를 수 없었다. 저장은
   * 카드 그리기 + 번호 읽기 + 업로드라 문제당 몇 초씩 걸리는데, 사람은 그동안 놀고
   * 있었다. 지금은 조각을 **저장 줄(`bgRef`)에 넘기고** 바로 다음 지면을 연다 — 줄은 한
   * 번에 하나씩만 돈다(동시에 저장하면 `sort_order` 가 겹친다).
   *
   * - `asis`: AI 로 다시 그리지 않고 잘린 그림 그대로 저장한다. 번호만 Mathpix 로 읽어
   *   붙인다(통째로 넣은 문제는 본문이 비어 있어 번호를 뽑을 데가 없다).
   * - `ai`: 저장 뒤 **행 id 를 달아** 다시 그리기 큐에 넣는다(탭을 닫아도 서버가 그 행에
   *   결과를 쓴다). 저장되는 그림은 우선 원본 크롭이라 그리기 전에 봐도 빈 자리가 아니다.
   *
   * 실패한 조각은 버리지 않고 `failedItems` 에 남겨 "다시 시도"할 수 있게 한다.
   */
  function submit(kind: "asis" | "ai", batch: Piece[] = pieces, pageNo?: number) {
    if (batch.length === 0) return;
    setError(null);
    const page = pageNo ?? Math.max(1, totalPages - queue.length);
    const pageTag = totalPages > 1 ? `지면 ${page} · ` : "";
    setBg((b) => ({ ...b, pending: b.pending + batch.length }));
    bgRef.current = bgRef.current
      .then(() => runBatch(kind, batch, pageTag))
      .catch(() => undefined);
    if (allRest && unlimited && queue.length > 0) {
      const rest = queue;
      setQueue([]);
      nextPage(true);
      void processRestPages(kind, rest, page + 1);
      return;
    }
    // 넘긴 조각은 화면에서 뺀다(같은 것을 두 번 넣지 않게). 다음 지면이 있으면 곧바로 연다.
    nextPage();
  }

  async function runBatch(kind: "asis" | "ai", batch: Piece[], pageTag: string) {
    for (let i = 0; i < batch.length; i++) {
      const piece = batch[i];
      try {
        // 번호는 luna 가 영역을 찾으며 이미 읽었다. 손으로 그린 조각처럼 그게 없을 때만 Mathpix 로 읽는다.
        const numberP = piece.no != null ? Promise.resolve(piece.no) : readNumberWithMathpix(piece.crop);
        const card = await wholeProblemCard(piece.id, piece.crop);
        const problemId = await onSave({
          pngDataUrl: card.pngDataUrl,
          text: "",
          answer: "",
          answerType: "choice",
          boxRange: card.boxRange,
        });
        if (kind === "ai") {
          enqueue({
            id: piece.id,
            problemKey: `batch:${problemId}`,
            label: `${pageTag}${i + 1}번째 문제`,
            crop: piece.crop,
            mode: "problem",
            problemId,
          });
        }
        const number = await numberP;
        let answered = 0;
        if (number != null) {
          const entry = await attachNumberAndAnswer(problemId, number, answerByNumber).catch(() => null);
          if (entry) answered = 1;
        }
        setBg((b) => ({
          ...b,
          pending: b.pending - 1,
          done: b.done + 1,
          numbered: b.numbered + (number != null ? 1 : 0),
          answered: b.answered + answered,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "알 수 없는 오류";
        setFailedItems((f) => [...f, { kind, piece, label: `${pageTag}${i + 1}번째`, msg }]);
        setBg((b) => ({ ...b, pending: b.pending - 1 }));
      }
    }
  }

  /** 실패한 조각들을 다시 저장 줄에 넣는다. */
  function retryFailed() {
    const items = failedItems;
    if (items.length === 0) return;
    setFailedItems([]);
    for (const kind of ["asis", "ai"] as const) {
      const batch = items.filter((f) => f.kind === kind).map((f) => f.piece);
      if (batch.length === 0) continue;
      setBg((b) => ({ ...b, pending: b.pending + batch.length }));
      bgRef.current = bgRef.current.then(() => runBatch(kind, batch, "다시 · ")).catch(() => undefined);
    }
  }

  // 고정 차감 × 개수 — 2026-09-17부터 실제 차감액과 정확히 같다.
  const totalCost =
    typeof figureCost === "number" ? figureCost * pieces.length : null;

  return (
    <div
      className="flex flex-col gap-3"
      // 지면 사진 여러 장을 끌어다 놓아도 된다 — 지금 지면이 있으면 대기열 끝에 붙는다.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/") || isHeicFile(f));
        if (files.length === 0) return;
        e.preventDefault();
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        void (pageImage ? addMore(dt.files) : pick(dt.files));
      }}
    >
      {!pageImage && (
        <p className="text-xs text-slate-500">
          지면 사진을 <b>여러 장 한꺼번에</b> 고르거나 끌어다 놓으세요 — 한 장씩 차례로 열리고, 넣는 동안 다음 지면은 미리 잘라 둡니다.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => void pick(e.target.files)}
          className="g-file min-w-0 flex-1"
        />
        <input
          ref={moreRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => void addMore(e.target.files)}
          className="hidden"
        />
        {pageImage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => moreRef.current?.click()}
          >
            + 지면 더 추가
          </Button>
        )}
        {pageImage && <CropShapeToggle value={shape} onChange={setShape} />}
      </div>

      {pageImage && totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <span className="font-medium text-slate-800">
            지면 {Math.max(1, totalPages - queue.length)}/{totalPages}
          </span>
          {queue.length > 0 ? (
            <>
              <span className="text-slate-400">다음:</span>
              {queue.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex max-w-[10rem] items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5"
                >
                  <span className="truncate">{f.name}</span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-label={`${f.name} 빼기`}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-40"
                    onClick={() => setQueue((q) => q.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </>
          ) : (
            <span className="text-slate-400">마지막 지면이에요.</span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={busy !== null}
            onClick={() => nextPage()}
          >
            {queue.length > 0 ? "이 지면 건너뛰기" : "지면 닫기"}
          </Button>
        </div>
      )}

      {pageImage && (
        <>
          <p className="text-xs text-slate-500">
            {boxes.length === 0
              ? shape === "poly"
                ? "문제 하나를 감싸도록 점을 찍거나, 끌어서 네모로 시작한 뒤 점을 옮기세요."
                : "사진 위에서 손가락이나 마우스로 문제 하나를 감싸는 네모를 그리세요."
              : `${boxes.length}개를 그렸어요. 끌어 옮기거나 모서리·점으로 모양을 고치고, × 로 지울 수 있어요.`}
          </p>
          {/* 손으로 그리는 편집기는 국어 모드와 같은 것을 쓴다 — 예전에는 여기만
              따로 그려서 그린 네모를 옮기거나 크기를 고칠 수가 없었다(지우고 다시
              그려야 했다). 그린 차례가 곧 번호다. */}
          <div className={busy ? "pointer-events-none opacity-60" : undefined}>
            <BoxEditor
              image={pageImage}
              boxes={boxes}
              onChange={setBoxes}
              shape={shape}
              color="#7c3aed"
 />
          </div>
        </>
      )}

      {pageImage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void cutManual()}
            disabled={busy !== null || boxes.length === 0}
            variant="primary"
          >
            그린 자리대로 자르기{boxes.length > 0 && ` (${boxes.length}개)`}
          </Button>
          {/* 자동으로 찾기는 유료 호출이라 무제한 계정에서만 보인다.
              막는 자리는 서버다 — 화면은 얼마든지 우회할 수 있다. */}
          {unlimited && (
            <Button
              type="button"
              onClick={() => void detect()}
              disabled={busy !== null}
              variant="outline"
            >
              자동으로 찾기
            </Button>
          )}
          {picked.size >= 2 && (
            <Button
              type="button"
              onClick={() => void mergeSelected()}
              disabled={busy !== null}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              고른 것 합치기 ({picked.size}개)
            </Button>
          )}
          {pieces.length > 0 && (
            <Button
              type="button"
              onClick={() => submit("asis")}
              disabled={busy !== null}
              variant="dark"
              title="AI로 다시 그리지 않고 잘린 그림 그대로 저장합니다. 문제 번호만 인식해서 붙입니다."
            >
              그대로 넣기 ({pieces.length}개)
            </Button>
          )}
          {pieces.length > 0 && (
            <Button
              type="button"
              onClick={() => submit("ai")}
              disabled={busy !== null}
              variant="soft"
            >
              모두 AI로 재생성 ({pieces.length}개
              {totalCost !== null && !unlimited && !byok && ` · ${totalCost}토큰`})
            </Button>
          )}
        </div>
      )}

      {unlimited && pieces.length > 0 && queue.length > 0 && (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={allRest}
            onChange={(e) => setAllRest(e.target.checked)}
            className="h-4 w-4 accent-blue-600"
          />
          남은 지면 {queue.length}장도 같은 방식으로 한 번에 넣기 (luna 가 찾은 자리대로)
        </label>
      )}
      {autoPages > 0 && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
          남은 지면 {autoPages}장을 luna 가 찾은 자리대로 자르는 중이에요 — 창은 닫지 마세요.
        </p>
      )}
      {busy && <p className="text-xs text-slate-500">{busy}</p>}
      {!busy && usedModel && pieces.length > 0 && (
        <p className="text-[11px] text-slate-400">
          {usedModel} 로 {pieces.length}개를 잡았습니다
          {refinedCount > 0 && ` · 문제마다 확대해 ${refinedCount}곳을 다시 맞췄어요`}
          {snapped > 0 && ` · 테두리 ${snapped}곳을 글자에 맞춰 다듬었어요`}
        </p>
      )}
      {bg.pending > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ⚠ 저장 중이에요 ({bg.pending}개 남음). 끝날 때까지 이 창을 닫거나 나가지 마세요. 저장이 끝나면 AI 그리기는
          서버가 이어서 하니 그때부터는 나가도 돼요.
        </p>
      )}
      {bg.done > 0 && (
        <p className="text-sm text-emerald-700">
          {bg.done}개 저장 완료
          {bg.numbered === bg.done
            ? " · 번호 전부 인식"
            : ` · 번호 ${bg.numbered}개 인식(나머지는 “수정”에서 직접)`}
          {bg.answered > 0 && ` · 정답 ${bg.answered}개 붙임`}
        </p>
      )}
      {failedItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-600">
          <span>
            저장 못 한 {failedItems.length}개 ({failedItems[0].label}
            {failedItems.length > 1 ? " 외" : ""}): {failedItems[0].msg}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={retryFailed}>
            다시 시도
          </Button>
        </div>
      )}
      {pieces.length > 0 && sourceInfo && (
        <p
          className={
            "text-xs " + (sourceInfo.degraded ? "font-medium text-amber-700" : "text-slate-500")
          }
        >
          {sourceInfo.degraded
            ? `⚠ 원본 사진을 열지 못해 화면용 축소본(${sourceInfo.w}×${sourceInfo.h})에서 잘랐어요. 조각이 흐릴 수 있어요 — 사진을 캡처하거나 갤러리에서 다시 저장해 올리면 원본 해상도로 잘려요.`
            : `원본 ${sourceInfo.w}×${sourceInfo.h} 사진에서 잘랐어요. 조각 왼쪽 아래 숫자가 실제 픽셀 크기예요(글이 또렷하려면 폭 1000px 이상).`}
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {pieces.length > 0 && (
        <p className="text-[11px] text-slate-500">
          한 문제가 둘로 쪼개졌으면 그 조각들을 눌러 고른 뒤 “고른 것 합치기”를
          누르세요. 원본에서 다시 잘라 붙이므로 이음매가 남지 않습니다.
        </p>
      )}

      {pieces.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {pieces.map((p, i) => (
            <li
              key={p.id}
              /* 카드를 누르면 고른다/뗀다. 둘 이상 고르면 합칠 수 있다. */
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  return next;
                })
              }
              className={
                "relative cursor-pointer overflow-hidden rounded-lg border bg-white " +
                (picked.has(p.id)
                  ? "border-blue-500 ring-2 ring-blue-400"
                  : "border-slate-200")
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.crop}
                alt=""
                className="w-full object-contain"
                onLoad={(e) => {
                  const t = e.currentTarget;
                  const label = `${t.naturalWidth}×${t.naturalHeight}`;
                  setPieceSizes((prev) => (prev[p.id] === label ? prev : { ...prev, [p.id]: label }));
                }}
              />
              {pieceSizes[p.id] && (
                <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 text-[10px] tabular-nums text-white">
                  {pieceSizes[p.id]}
                </span>
              )}
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[11px] text-white">
                {picked.has(p.id) ? "✓ " : ""}
                {i + 1}
                {p.parts > 1 && ` · ${p.parts}조각 합침`}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  // 카드의 "고르기"까지 같이 걸리면 지우면서 선택이 켜진다.
                  e.stopPropagation();
                  setPieces((prev) => prev.filter((x) => x.id !== p.id));
                  setPicked((prev) => {
                    const next = new Set(prev);
                    next.delete(p.id);
                    return next;
                  });
                }}
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

/**
 * 번호·선지 둘레 여유(지면 대비). 사진 한 장 자르기(`KEEP_PAD` 1.2%)보다 좁다 — 지면에서는 바로 아래가 다음 문제라 넓게
 * 두르면 그 첫 줄이 딸려 온다.
 */
const PAGE_KEEP_PAD = 0.005;

/** 다듬은 자리가 luna 가 짚은 번호·선지(`keep`)를 다 품게 넓힌다. keep 이 없으면 그대로. */
function withKeep(b: ProblemBox, orig: ProblemBox): ProblemBox {
  const keep = (orig as ProblemBox & { keep?: ProblemBox[] }).keep;
  if (!Array.isArray(keep) || keep.length === 0) return b;
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  for (const k of keep) {
    x0 = Math.max(0, Math.min(x0, k.x - PAGE_KEEP_PAD));
    y0 = Math.max(0, Math.min(y0, k.y - PAGE_KEEP_PAD));
    x1 = Math.min(1, Math.max(x1, k.x + k.w + PAGE_KEEP_PAD));
    y1 = Math.min(1, Math.max(y1, k.y + k.h + PAGE_KEEP_PAD));
  }
  return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
