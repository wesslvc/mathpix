"use client";

import { useEffect, useState } from "react";
import { enhanceContrast } from "@/lib/autoContrast";
import { cropImageToDataUrl, fileToDataUrl, isHeicFile, loadImage } from "@/lib/cropImage";
import {
  DETECT_INPUT_DIM,
  MAX_UPLOAD_CHARS,
  PROBLEM_INPUT_DIM,
  PROBLEM_MAX_HEIGHT,
  stitchVertically,
} from "@/lib/figureImage";
import BoxEditor, { type EditBox } from "@/components/BoxEditor";
import type { DetectedKoreanRegion } from "@/lib/detectProblems";
import type { ProblemBox } from "@/lib/problemBoxes";
import { imageSizeOf } from "@/lib/figureImage";
import {
  attachPassageFigures,
  existingPassageFigures,
  figuresForReader,
  type PassageFigureInput,
} from "@/lib/passageFigures";
import { passageStrips } from "@/lib/passageMarks";
import {
  applyMarksReview,
  describeMarksReview,
  reviewParagraphs,
  type MarksReviewPara,
} from "@/lib/kice/marksReview";
import { buildKicePdf } from "@/lib/kice/pdf";
import { frameKeyFor, loadFrameImages, loadKiceFrames } from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import {
  describeMarks,
  emptyMarkStats,
  readRichBlocks,
  richToPlainText,
  type RichBlock,
} from "@/lib/kice/richText";

/**
 * **국어 지문 인식 비교** — 무제한 계정 전용 시험 화면.
 *
 * 한 지문 사진을 **운영과 같은 한 번의 호출**(글자와 서식 구간을 함께 읽는다,
 * `KOREAN_TEXT_PROMPT`)로 두 번 보내 평가원 양식 PDF 를 각각 뽑는다. 2026-09-25
 * 사용자 지시로 **모델은 운영 값(gpt-6-sol)으로 고정하고 추론 강도만** 칸마다
 * 바꿔 견준다 — OpenAI 만 된다.
 */

/** 운영 지문 인식 모델(`OPENAI_TEXT_MODEL` 기본값과 같다). */
const READ_MODEL = "gpt-6-sol";

/** 눌러서 고르는 추론 강도 — 2026-09-25 probe 로 받는 값을 확인했다. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * 지문 위치 찾기 칸에서 눌러 고르는 OpenAI 모델. 둘 다 이 계정의 `/v1/models`
 * 에 있고 사진 요청이 실제로 통한 것만 둔다(2026-09-25 probe).
 */
const OPENAI_PRESETS = ["gpt-6-luna", "gpt-6-sol"];

type Reader = { key: "a" | "b"; effort: string };

// 기본은 운영 강도(medium)와 한 단계 위(high).
const DEFAULT_READERS: Reader[] = [
  { key: "a", effort: "medium" },
  { key: "b", effort: "high" },
];

type Result =
  | { state: "idle" }
  | { state: "running"; since: number; note?: string }
  | {
      state: "done";
      blocks: RichBlock[];
      model: string;
      ms: number;
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
      /** 공표 단가로 계산한 원가(원). 단가를 모르는 모델이면 null. */
      estKrw: number | null;
      /** 서식 표시를 제자리에 붙인 결과(`describeMarks`). */
      marksNote: string;
      /** 그림을 붙인 결과(`attachPassageFigures`). */
      figuresNote: string;
      /** 서식 검수(두 번째 호출) 결과 한 줄. 끄면 빈 글자. */
      reviewNote: string;
      /** 검수에 든 시간(ms)·원가. */
      reviewMs?: number;
      reviewKrw?: number | null;
      /** 모델이 준 그대로의 블록(JSON) — 서식 구간을 어떻게 짚었는지 본다. */
      raw: string;
      pdfUrl: string;
      chars: number;
    }
  | { state: "error"; message: string; ms?: number };

/** 지문 네모가 가질 묶음 id — 그린 것 전부가 한 지문이다(국어 모드와 같다). */
const PASSAGE_GROUP = "passage";
/** 지문 안 그림 네모(국어 모드와 같다). */
const FIGURE_GROUP = "figure";

/**
 * 모델에 보낼 지문 사진과 그 안의 그림들. **운영 국어 모드와 똑같이 만든다** —
 * 원본에서 네모대로 자르고(폭 1536·높이 3000 상한) 여러 개면 읽는 차례대로
 * 세로로 이어 붙인 뒤 대비를 올린다. 그림은 따로 자르고 폭 비율을 지문 네모에
 * 견준다. 여기만 다르면 견준 결과가 운영에 안 맞는다.
 * 지문 네모를 안 그렸으면 사진 전체를 같은 상한으로 보낸다.
 */
async function passageImage(
  file: File,
  boxes: EditBox[],
): Promise<{ image: string; figures: PassageFigureInput[] }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const limits = { maxWidth: PROBLEM_INPUT_DIM, maxHeight: PROBLEM_MAX_HEIGHT };
    const cutOut = (b: { x: number; y: number; w: number; h: number }) =>
      cropImageToDataUrl(img, { x: b.x * W, y: b.y * H, width: b.w * W, height: b.h * H }, limits);
    const passages = boxes.filter((b) => b.group !== FIGURE_GROUP);
    const parts =
      passages.length > 0
        ? passages.map(cutOut)
        : [cropImageToDataUrl(img, { x: 0, y: 0, width: W, height: H }, limits)];
    const figures = boxes
      .filter((b) => b.group === FIGURE_GROUP)
      .map((f) => {
        const cx = f.x + f.w / 2;
        const cy = f.y + f.h / 2;
        const host = passages.find(
          (p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h,
        );
        return {
          crop: cutOut(f),
          scale: host ? Math.min(1, Math.max(0.15, f.w / host.w)) : 0.8,
        };
      });
    const stitched = await stitchVertically(parts);
    const enhanced = await enhanceContrast(stitched);
    const out = enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : stitched;
    if (out.length > MAX_UPLOAD_CHARS) {
      throw new Error("지문 사진이 너무 큽니다. 네모를 나눠 그려 주세요.");
    }
    return { image: out, figures };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ReadResponse = {
  jobId?: string;
  blocks?: unknown;
  regions?: DetectedKoreanRegion[];
  figures?: ProblemBox[];
  review?: MarksReviewPara[];
  model?: string;
  ms?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  estKrw?: number | null;
  error?: string;
};

/** 백그라운드 작업이 끝날 때까지 기다린다. 30분이 넘으면 포기한다. */
async function waitForJob(
  jobId: string,
  task: "read" | "detect" | "marks" = "read",
): Promise<ReadResponse> {
  const until = Date.now() + 30 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    let poll: ReadResponse & { status?: string; message?: string };
    try {
      const res = await fetch(`/api/admin/compare-korean?id=${encodeURIComponent(jobId)}&task=${task}`, {
        cache: "no-store",
      });
      poll = await res.json();
    } catch {
      // 한 번 물어보다 끊긴 건 괜찮다 — 다음에 다시 묻는다.
      if (Date.now() > until) throw new Error("30분이 지나도 끝나지 않았습니다.");
      continue;
    }
    if (poll.status === "done") return poll;
    if (poll.status === "error") throw new Error(poll.message ?? poll.error ?? "실패했습니다.");
    if (Date.now() > until) throw new Error("30분이 지나도 끝나지 않았습니다.");
  }
}

/** 운영 국어 모드가 자동으로 잡은 네모에 더하는 여유(`KoreanModePanel` 의 PAD 와 같다). */
const AUTO_PAD = 0.004;

/**
 * 위치 찾기에 보낼 지면 사진. **운영 국어 모드의 `detectImage` 와 같다** — 원본에서
 * 긴 변 3000px 부터 요청 상한에 들어갈 때까지 줄이고 대비를 올린다.
 */
async function detectImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const whole = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    let last = "";
    for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
      last = cropImageToDataUrl(img, whole, { maxWidth: dim, maxHeight: dim });
      if (last.length <= MAX_UPLOAD_CHARS) break;
    }
    const enhanced = await enhanceContrast(last);
    return enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : last;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 찾은 지문 조각과 그림을 네모로. 읽는 차례(왼쪽 단 위→아래, 그다음 오른쪽 단)로.
 * 지문에는 운영처럼 여유(`AUTO_PAD`)를 준다.
 */
function passageBoxesFrom(regions: DetectedKoreanRegion[], figures: ProblemBox[]): EditBox[] {
  const col = (b: ProblemBox) => (b.x + b.w / 2 < 0.5 ? 0 : 1);
  const order = (a: ProblemBox, b: ProblemBox) => col(a) - col(b) || a.y - b.y;
  const passages = regions
    .filter((r) => r.kind === "passage")
    .map((r) => r.box)
    .sort(order)
    .map((b) => {
      const x = Math.max(0, b.x - AUTO_PAD);
      const y = Math.max(0, b.y - AUTO_PAD);
      return {
        id: crypto.randomUUID(),
        x,
        y,
        w: Math.min(1 - x, b.w + AUTO_PAD * 2),
        h: Math.min(1 - y, b.h + AUTO_PAD * 2),
        group: PASSAGE_GROUP,
      };
    });
  const figs = [...figures]
    .sort(order)
    .map((b) => ({ id: crypto.randomUUID(), ...b, group: FIGURE_GROUP }));
  return [...passages, ...figs];
}

type Detector = {
  provider: "openai" | "gemini";
  model: string;
  effort: string;
};

type DetectRun = {
  id: string;
  label: string;
  since: number;
} & (
  | { state: "running" }
  | {
      state: "done";
      ms: number;
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
      estKrw: number | null;
      /** 찾은 지문 자리와 그림 자리(네모). */
      passages: EditBox[];
      figures: number;
    }
  | { state: "error"; ms: number; message: string }
);

async function makePdf(blocks: RichBlock[], title: string, tocLine: string): Promise<string> {
  const [all, fonts] = await Promise.all([loadKiceFrames(), loadKiceFonts()]);
  const frames = all[frameKeyFor("국어")];
  const images = await loadFrameImages(frames);
  const bytes = await buildKicePdf({
    frames,
    replace: title ? { "2025학년도대학수학능력시험문제지": title } : {},
    fonts,
    images,
    problems: [],
    pagePattern: [1],
    koreanPlan: { toc: [tocLine], pages: [{ kind: "toc" }, { kind: "passageText", blocks }] },
    answers: [],
    onWarn: (m) => console.warn("[compare-korean]", m),
  });
  return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/pdf" }));
}

/** 칸 머리글·PDF 제목. */
function readerTitle(r: Reader): string {
  return `${READ_MODEL} · ${r.effort || "기본"}`;
}

export default function CompareKoreanPage() {
  const [readers, setReaders] = useState<Reader[]>(DEFAULT_READERS);
  // 기본은 운영과 같은 값(gpt-6-luna medium, `OPENAI_DETECT_EFFORT`).
  const [detector, setDetector] = useState<Detector>({
    provider: "openai",
    model: "gpt-6-luna",
    effort: "medium",
  });
  /** 새로 그리는 네모가 지문인가 그림인가. */
  const [drawKind, setDrawKind] = useState<"passage" | "figure">("passage");
  /** 그림을 sunburst 로 다시 그려 붙일까(끄면 원본 크롭을 붙인다 — 돈이 안 든다). */
  const [redrawFigures, setRedrawFigures] = useState(true);
  /** 그림 준비 진행(두 칸이 같은 그림을 나눠 쓴다). */
  const [figureNote, setFigureNote] = useState<string | null>(null);
  const [detectRuns, setDetectRuns] = useState<DetectRun[]>([]);
  const [file, setFile] = useState<File | null>(null);
  /** 네모를 그릴 화면용 사진(긴 변 1600). 자르는 건 원본에서 한다. */
  const [preview, setPreview] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<EditBox[]>([]);
  /** 실제로 두 모델에 보낸 그림 — 무엇을 견줬는지 눈으로 확인한다. */
  const [sent, setSent] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({ a: { state: "idle" }, b: { state: "idle" } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patchReader(key: Reader["key"], patch: Partial<Reader>) {
    setReaders((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function pick(f: File | null) {
    setFile(null);
    setPreview(null);
    setBoxes([]);
    setFigureNote(null);
    setDetectRuns([]);
    setSent(null);
    setResults({ a: { state: "idle" }, b: { state: "idle" } });
    setError(null);
    if (!f) return;
    if (isHeicFile(f)) {
      setError("HEIC 는 열 수 없습니다. JPG/PNG 로 올려주세요.");
      return;
    }
    try {
      setPreview(await fileToDataUrl(f));
      setFile(f);
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
    }
  }

  /**
   * 지문 위치를 찾는다. 여러 번 돌려 모델·강도끼리 견줄 수 있게 **기록을 쌓고**,
   * 끝난 결과는 곧바로 지문 네모로 옮긴다(다른 결과의 "이걸로" 로 바꿀 수 있다).
   */
  async function runDetect() {
    if (!file) return;
    const d = detector;
    const id = crypto.randomUUID();
    const since = Date.now();
    const label = d.provider === "openai" && d.effort ? `${d.model} · ${d.effort}` : d.model;
    setDetectRuns((rs) => [{ id, label, since, state: "running" }, ...rs]);
    const settle = (run: DetectRun) => setDetectRuns((rs) => rs.map((r) => (r.id === id ? run : r)));
    try {
      const res = await fetch("/api/admin/compare-korean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "detect",
          image: await detectImage(file),
          provider: d.provider,
          model: d.model,
          effort: d.provider === "openai" ? d.effort : "",
        }),
      });
      let json = (await res.json().catch(() => ({}))) as ReadResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.jobId) json = await waitForJob(json.jobId, "detect");
      const passages = passageBoxesFrom(json.regions ?? [], json.figures ?? []);
      settle({
        id,
        label,
        since,
        state: "done",
        ms: Date.now() - since,
        usage: json.usage,
        estKrw: json.estKrw ?? null,
        passages,
        figures: passages.filter((b) => b.group === FIGURE_GROUP).length,
      });
      if (passages.length > 0) setBoxes(passages);
    } catch (err) {
      settle({
        id,
        label,
        since,
        state: "error",
        ms: Date.now() - since,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runOne(
    reader: Reader,
    image: string,
    /** sol 에게 보낼 그림(작은 사본). */
    forReader: string[],
    /** 붙일 그림(한 번만 준비해 두 칸이 나눠 쓴다). 읽기가 끝난 뒤에 기다린다. */
    ready: Promise<PassageFigureInput[]>,
  ) {
    const since = Date.now();
    setResults((r) => ({ ...r, [reader.key]: { state: "running", since } }));
    try {
      const res = await fetch("/api/admin/compare-korean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          figures: forReader,
          provider: "openai",
          model: READ_MODEL,
          effort: reader.effort,
        }),
      });
      let json = (await res.json().catch(() => ({}))) as ReadResponse;
      if (!res.ok) {
        throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { ms: json.ms });
      }
      // 백그라운드로 걸려 id 만 온다 — 끝날 때까지 몇 초마다 물어본다.
      // 함수 한도(300초)에 안 묶이므로 높은 강도도 끝까지 기다릴 수 있다.
      if (json.jobId) json = await waitForJob(json.jobId);
      // 운영과 똑같이 읽는다(`text` + `marks` → 토막) — 여기만 다르면 견준 결과가 어긋난다.
      const stats = emptyMarkStats();
      const read = readRichBlocks(json.blocks, 0, stats);
      if (read.length === 0) throw new Error("문단을 하나도 읽지 못했습니다.");
      // 서식 검수 — 운영과 같은 두 번째 호출을 **이 칸의 강도로** 건다.
      let reviewNote = "";
      let reviewMs: number | undefined;
      let reviewKrw: number | null | undefined;
      let review: MarksReviewPara[] | undefined;
      {
        const t0 = Date.now();
        setResults((r) => ({ ...r, [reader.key]: { state: "running", since, note: "서식 검수 중…" } }));
        try {
          const { overview, strips } = await passageStrips(image);
          const mres = await fetch("/api/admin/compare-korean", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              task: "marks",
              image: overview,
              strips,
              paragraphs: reviewParagraphs(read),
              provider: "openai",
              model: READ_MODEL,
              effort: reader.effort,
            }),
          });
          let mj = (await mres.json().catch(() => ({}))) as ReadResponse;
          if (!mres.ok) throw new Error(mj.error ?? `HTTP ${mres.status}`);
          if (mj.jobId) mj = await waitForJob(mj.jobId, "marks");
          review = mj.review;
          reviewKrw = mj.estKrw ?? null;
        } catch (err) {
          reviewNote = `서식 검수 실패 — 첫 결과 그대로 (${err instanceof Error ? err.message : String(err)})`;
        }
        reviewMs = Date.now() - t0;
      }
      const attached = await attachPassageFigures(read, await ready);
      let blocks = attached.blocks;
      if (review) {
        const applied = applyMarksReview(blocks, review);
        blocks = applied.blocks;
        reviewNote = describeMarksReview(applied.stats);
      }
      const model = json.model ?? READ_MODEL;
      const tag = reader.effort ? `${model} (${reader.effort})` : model;
      const pdfUrl = await makePdf(blocks, `지문 비교 — ${readerTitle(reader)}`, `2p, ${tag}`);
      setResults((r) => ({
        ...r,
        [reader.key]: {
          state: "done",
          blocks,
          model: tag,
          ms: Date.now() - since,
          usage: json.usage,
          estKrw: json.estKrw ?? null,
          marksNote: describeMarks(stats) || "굵게·밑줄·네모 표시 없음",
          figuresNote: attached.note,
          reviewNote,
          reviewMs,
          reviewKrw,
          raw: JSON.stringify(json.blocks, null, 1),
          pdfUrl,
          chars: richToPlainText(blocks).length,
        },
      }));
    } catch (err) {
      setResults((r) => ({
        ...r,
        [reader.key]: {
          state: "error",
          message: err instanceof Error ? err.message : String(err),
          ms: (err as { ms?: number }).ms ?? Date.now() - since,
        },
      }));
    }
  }

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      // **그린 차례가 곧 이어 붙이는 차례다**(운영 국어 모드와 같다) — 단을 넘는
      // 지문은 왼쪽 단 조각부터 그리면 된다.
      const { image, figures } = await passageImage(file, boxes);
      setSent(image);
      const forReader = await figuresForReader(figures);
      // 그림은 **한 번만** 준비해 두 칸이 나눠 쓴다(sunburst 는 sol 과 무관하다 —
      // 칸마다 다시 그리면 값이 두 배다). 읽기와 동시에 돌린다.
      const readyPromise: Promise<PassageFigureInput[]> =
        figures.length === 0
          ? Promise.resolve([])
          : redrawFigures
            ? (async () => {
                setFigureNote(`그림 ${figures.length}개를 sunburst 로 다시 그리는 중…`);
                const done = await attachPassageFigures([], figures, setFigureNote);
                setFigureNote(done.note.replace(/ · \d+개는 자리를 못 짚어 지문 끝에 붙였어요/, ""));
                return existingPassageFigures(done.blocks);
              })()
            : Promise.all(
                figures.map(async (f) => {
                  const size = await imageSizeOf(f.crop);
                  return { ...f, src: f.crop, ratio: size ? size.height / size.width : 1 };
                }),
              ).then((r) => {
                setFigureNote(`그림 ${figures.length}개 — 원본 크롭을 붙입니다`);
                return r;
              });
      // 두 칸을 동시에 — 각자 제 요청이라 한쪽이 늦어도 다른 쪽을 막지 않는다.
      // 읽기는 곧바로 걸고, 붙이는 순간에만 그림을 기다린다.
      await Promise.all(readers.map((r) => runOne(r, image, forReader, readyPromise)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">국어 지문 인식 비교</h1>
        <p className="mt-1 text-sm text-slate-600">
          같은 지문 사진을 운영과 같은 한 번의 호출({READ_MODEL})로 두 번 보내 평가원 양식 PDF 를
          각각 뽑습니다. 모델이 글자와 함께 굵게·밑줄·네모가 정확히 어디부터 어디까지인지 짚어
          줍니다. 칸마다 추론 강도만 바꿔 견줍니다. 토큰은 차감하지 않습니다(무제한 계정 전용).
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          지문 사진
          <input
            type="file"
            accept="image/*"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </label>
        {preview && (
          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
            <p className="text-sm font-medium text-slate-700">① 지문 위치 자동으로 찾기 (선택)</p>
            <p className="text-xs text-slate-500">
              운영 국어 모드의 지문 찾기와 같은 호출입니다 — 지문 자리와 <b>지문 안 그림</b>
              자리를 함께 찾아요(문제는 찾지 않습니다). 모델·강도를 바꿔 여러 번 돌려 견줄 수
              있고, 끝나면 찾은 자리가 아래 사진에 들어가요.
            </p>
            <div className="flex flex-wrap items-end gap-2 text-xs">
              {(["openai", "gemini"] as const).map((pv) => (
                <button
                  key={pv}
                  type="button"
                  onClick={() =>
                    setDetector((d) => ({
                      ...d,
                      provider: pv,
                      model: pv === "openai" ? OPENAI_PRESETS[0] : "gemini-3.8-flash",
                      effort: pv === "openai" ? "medium" : "",
                    }))
                  }
                  className={`rounded-lg border px-2 py-1 ${
                    detector.provider === pv
                      ? "border-slate-800 bg-slate-800 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {pv === "openai" ? "OpenAI" : "Gemini"}
                </button>
              ))}
              {detector.provider === "openai" &&
                OPENAI_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDetector((d) => ({ ...d, model: m }))}
                    className={`rounded-lg border px-2 py-1 font-mono ${
                      detector.model === m
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-slate-600">
                모델
                <input
                  value={detector.model}
                  onChange={(e) => setDetector((d) => ({ ...d, model: e.target.value }))}
                  className="rounded border border-slate-300 px-2 py-1 font-mono"
                />
              </label>
              {detector.provider === "openai" && (
                <label className="flex w-24 flex-col gap-1 text-slate-600">
                  추론 강도
                  <input
                    value={detector.effort}
                    onChange={(e) => setDetector((d) => ({ ...d, effort: e.target.value }))}
                    className="rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </label>
              )}
              <button
                type="button"
                onClick={runDetect}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white"
              >
                위치 찾기
              </button>
            </div>
            {detectRuns.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs">
                {detectRuns.map((run) => (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-slate-50 px-2 py-1"
                  >
                    <span className="font-mono text-slate-800">{run.label}</span>
                    {run.state === "running" && <Elapsed since={run.since} />}
                    {run.state === "error" && (
                      <span className="break-words text-red-600">
                        실패 ({(run.ms / 1000).toFixed(1)}초) — {run.message}
                      </span>
                    )}
                    {run.state === "done" && (
                      <>
                        <span>{(run.ms / 1000).toFixed(1)}초</span>
                        <span>
                          {run.estKrw != null
                            ? `약 ${run.estKrw < 10 ? run.estKrw.toFixed(1) : Math.round(run.estKrw)}원`
                            : "단가 모름"}
                        </span>
                        {run.usage && (
                          <span className="text-slate-500">
                            입력 {run.usage.inputTokens.toLocaleString()} · 출력{" "}
                            {run.usage.outputTokens.toLocaleString()}
                          </span>
                        )}
                        <span>
                          지문 {run.passages.length - run.figures}조각 · 그림 {run.figures}개
                        </span>
                        {run.passages.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setBoxes(run.passages)}
                            className="rounded border border-emerald-600 px-2 py-0.5 text-emerald-700"
                          >
                            이 결과로 바꾸기
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {preview && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-600">
              ② 사진 위에 <b className="text-emerald-700">지문 영역</b>을 끌어서 네모로
              그리세요(발문 줄부터 지문 끝까지, 문항은 빼고). 단이나 쪽을 넘는 지문은 조각마다
              그리면 <b>그린 차례대로</b> 세로로 이어 붙입니다. 안 그리면 사진 전체를 보냅니다.
              지문 안 <b className="text-orange-600">그림</b>은 &quot;그림&quot;으로 바꿔 따로
              감싸세요 — sol 에게 알려 주고 그 자리에 붙입니다.
            </p>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-slate-500">새로 그리는 네모:</span>
              {(["passage", "figure"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDrawKind(k)}
                  className={`rounded-lg border px-2 py-1 ${
                    drawKind === k
                      ? k === "passage"
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : "border-orange-500 bg-orange-500 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {k === "passage" ? "지문" : "그림"}
                </button>
              ))}
            </div>
            <div className="max-w-xl">
              <BoxEditor
                image={preview}
                boxes={boxes}
                onChange={setBoxes}
                color="#059669"
                colorOf={(g) => (g === FIGURE_GROUP ? "#f97316" : "#059669")}
                newGroup={drawKind === "figure" ? FIGURE_GROUP : PASSAGE_GROUP}
                labelOf={(g) => (g === FIGURE_GROUP ? "그림" : "지문")}
              />
            </div>
            <p className="text-xs text-slate-500">
              {boxes.filter((b) => b.group !== FIGURE_GROUP).length === 0
                ? "지문 네모 없음 — 사진 전체"
                : `지문 네모 ${boxes.filter((b) => b.group !== FIGURE_GROUP).length}개`}
              {` · 그림 ${boxes.filter((b) => b.group === FIGURE_GROUP).length}개`}
            </p>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={redrawFigures}
                onChange={(e) => setRedrawFigures(e.target.checked)}
              />
              그림을 sunburst 로 다시 그려 붙이기 (끄면 원본 크롭을 붙임 · 한 번만 그려 두 칸이
              나눠 씀)
            </label>
            <p className="text-xs text-slate-500">
              서식 검수(2차 호출 — 확대한 띠로 원문자·밑줄 길이·네모·굵게만 다시 봄)는 운영과 같이
              늘 돕니다. 칸의 강도로 겁니다.
            </p>
            {figureNote && <p className="text-xs text-slate-500">{figureNote}</p>}
          </div>
        )}
        {sent && (
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500">
              실제로 보낸 그림 보기
            </summary>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sent} alt="보낸 지문" className="mt-2 max-h-[32rem] w-auto rounded border" />
          </details>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {readers.map((reader) => {
          const result = results[reader.key];
          return (
            <section
              key={reader.key}
              className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
            >
              <h2 className="font-semibold text-slate-900">{readerTitle(reader)}</h2>
              <div className="flex flex-wrap items-end gap-1 text-xs">
                {EFFORTS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => patchReader(reader.key, { effort: e })}
                    className={`rounded-lg border px-2 py-1 font-mono ${
                      reader.effort === e
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {e}
                  </button>
                ))}
                <label className="ml-1 flex w-24 flex-col gap-1 text-slate-600">
                  추론 강도
                  <input
                    value={reader.effort}
                    onChange={(e) => patchReader(reader.key, { effort: e.target.value.trim() })}
                    className="rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </label>
              </div>

              <ResultView result={result} />
            </section>
          );
        })}
      </div>

      <button
        type="button"
        disabled={!file || busy}
        onClick={run}
        className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
      >
        {busy ? "읽는 중…" : "두 강도로 읽고 PDF 만들기"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}

function ResultView({ result }: { result: Result }) {
  if (result.state === "idle") return <p className="text-xs text-slate-400">아직 안 돌렸어요.</p>;
  if (result.state === "running") return <Elapsed since={result.since} note={result.note} />;
  if (result.state === "error") {
    return (
      <p className="break-words text-sm text-red-600">
        실패{result.ms ? ` (${(result.ms / 1000).toFixed(1)}초)` : ""} — {result.message}
      </p>
    );
  }
  const u = result.usage;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ul className="text-xs text-slate-600">
        <li>
          답한 모델: <span className="font-mono">{result.model}</span>
        </li>
        <li>걸린 시간: {(result.ms / 1000).toFixed(1)}초</li>
        {u && (
          <li>
            토큰: 입력 {u.inputTokens.toLocaleString()}
            {u.cachedInputTokens ? ` (캐시 ${u.cachedInputTokens.toLocaleString()})` : ""} · 출력{" "}
            {u.outputTokens.toLocaleString()}(생각 포함)
          </li>
        )}
        <li>
          원가:{" "}
          {result.estKrw != null
            ? `약 ${
                result.estKrw < 10 ? result.estKrw.toFixed(1) : Math.round(result.estKrw).toLocaleString()
              }원 (공표 단가 기준)`
            : "단가 모름"}
        </li>
        <li>
          블록 {result.blocks.length}개 · 글자 {result.chars.toLocaleString()}자
        </li>
        <li>1차(읽기) 서식: {result.marksNote}</li>
        {result.reviewNote && (
          <li>
            2차 {result.reviewNote}
            {result.reviewMs != null ? ` · ${(result.reviewMs / 1000).toFixed(1)}초` : ""}
            {result.reviewKrw != null
              ? ` · 약 ${result.reviewKrw < 10 ? result.reviewKrw.toFixed(1) : Math.round(result.reviewKrw)}원`
              : ""}
          </li>
        )}
        {result.figuresNote && <li>{result.figuresNote}</li>}
      </ul>
      <a
        href={result.pdfUrl}
        download={`지문비교_${result.model.replace(/[^\w.-]+/g, "_")}.pdf`}
        className="self-start rounded-lg border border-blue-600 px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50"
      >
        PDF 받기
      </a>
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500">읽은 글 보기</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2">
          {richToPlainText(result.blocks)}
        </pre>
      </details>
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500">모델이 준 그대로 보기 (서식 구간)</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 font-mono">
          {result.raw}
        </pre>
      </details>
    </div>
  );
}

function Elapsed({ since, note }: { since: number; note?: string }) {
  const [, tick] = useState(0);
  // 1초마다 다시 그려 경과 시간을 보여 준다.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="text-sm text-slate-500">
      {note ?? "읽는 중…"} {Math.round((Date.now() - since) / 1000)}초
    </p>
  );
}
