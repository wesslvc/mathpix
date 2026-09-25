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
import type { DetectedKoreanPolygon, DetectedKoreanRegion } from "@/lib/detectProblems";
import { buildKicePdf } from "@/lib/kice/pdf";
import { frameKeyFor, loadFrameImages, loadKiceFrames } from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import {
  alignCircledToReference,
  readRichBlocks,
  richToPlainText,
  type RichBlock,
} from "@/lib/kice/richText";

/**
 * **국어 지문 인식 모델 비교** — 무제한 계정 전용 시험 화면.
 *
 * 한 지문 사진을 두 모델에 **똑같이**(같은 프롬프트·같은 Mathpix 참고 글·같은
 * 원문자 교정) 보내 평가원 양식 PDF 를 각각 뽑는다. 무엇이 더 잘 보는지는
 * 짐작으로 못 정한다 — 실제 지문으로 나란히 놓고 본다.
 *
 * 모델 이름은 **확인한 것만** 기본값으로 둔다(`/api/figure-jobs/run` 의
 * probe 로 이름과 추론 강도를 실제로 불러 봤다). 칸을 고쳐 다른 이름도 견줄
 * 수 있지만, 없는 이름이면 그대로 실패로 뜬다 — 다른 모델로 몰래 갈아타지 않는다.
 */

type Reader = {
  key: "a" | "b";
  provider: "openai" | "gemini";
  model: string;
  effort: string;
};

// 둘 다 2026-09-25 probe 로 확인했다: `gemini-3.8-flash` 는 이 키의 ListModels 에
// 있고, gpt-6-luna 의 추론 강도는 none·minimal·low·medium·high·xhigh·max 를 받는다.
/**
 * 눌러서 고르는 OpenAI 모델. 둘 다 이 계정의 `/v1/models` 에 있고, 사진 +
 * `reasoning.effort: "max"` 요청이 실제로 통한 것만 둔다(2026-09-25 probe).
 * 다른 이름은 칸에 직접 적으면 된다.
 */
const OPENAI_PRESETS = ["gpt-6-luna", "gpt-6-sol"];

// 기본은 OpenAI 두 칸(luna max vs sol max). gemini-3.8-flash 는 첫 실행에서
// 503(자리 없음)만 받아 기본에서 뺐다 — 카드의 Gemini 버튼으로 언제든 되돌린다.
const DEFAULT_READERS: Reader[] = [
  { key: "a", provider: "openai", model: "gpt-6-luna", effort: "max" },
  { key: "b", provider: "openai", model: "gpt-6-sol", effort: "max" },
];

type Result =
  | { state: "idle" }
  | { state: "running"; since: number }
  | {
      state: "done";
      blocks: RichBlock[];
      model: string;
      ms: number;
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
      /** 공표 단가로 계산한 원가(원). 단가를 모르는 모델이면 null. */
      estKrw: number | null;
      circledFixed: number;
      circledMismatch: boolean;
      pdfUrl: string;
      chars: number;
    }
  | { state: "error"; message: string; ms?: number };

/** 지문 네모가 가질 묶음 id — 그린 것 전부가 한 지문이다(국어 모드와 같다). */
const PASSAGE_GROUP = "passage";

/**
 * 모델에 보낼 지문 사진. **운영 국어 모드와 똑같이 만든다** — 원본에서 네모대로
 * 자르고(폭 1536·높이 3000 상한, 여유 없음) 여러 개면 읽는 차례대로 세로로 이어
 * 붙인 뒤 대비를 올린다. 여기만 다르면 견준 결과가 운영에 안 맞는다.
 * 네모를 안 그렸으면 사진 전체를 같은 상한으로 보낸다.
 */
async function passageImage(
  file: File,
  boxes: EditBox[],
  polys: DetectedKoreanPolygon[] | null,
): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const limits = { maxWidth: PROBLEM_INPUT_DIM, maxHeight: PROBLEM_MAX_HEIGHT };
    const parts = polys && polys.length > 0
      ? polys.map((p) => cropPolygon(img, p))
      : boxes.length > 0
        ? boxes.map((b) =>
            cropImageToDataUrl(
              img,
              { x: b.x * W, y: b.y * H, width: b.w * W, height: b.h * H },
              limits,
            ),
          )
        : [cropImageToDataUrl(img, { x: 0, y: 0, width: W, height: H }, limits)];
    const stitched = await stitchVertically(parts);
    const enhanced = await enhanceContrast(stitched);
    const out = enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : stitched;
    if (out.length > MAX_UPLOAD_CHARS) {
      throw new Error("지문 사진이 너무 큽니다. 네모를 나눠 그려 주세요.");
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ReadResponse = {
  jobId?: string;
  blocks?: unknown;
  regions?: DetectedKoreanRegion[];
  polygons?: DetectedKoreanPolygon[];
  model?: string;
  ms?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  estKrw?: number | null;
  error?: string;
};

/** 백그라운드 작업이 끝날 때까지 기다린다. 30분이 넘으면 포기한다. */
async function waitForJob(
  jobId: string,
  task: "read" | "detect" = "read",
  shape: "box" | "polygon" = "box",
): Promise<ReadResponse> {
  const until = Date.now() + 30 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    let poll: ReadResponse & { status?: string; message?: string };
    try {
      const res = await fetch(`/api/admin/compare-korean?id=${encodeURIComponent(jobId)}&task=${task}&shape=${shape}`, {
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
 * 다각형 하나를 원본에서 떼어 낸다 — 감싸는 네모를 자르고 **다각형 바깥을 흰색으로**
 * 지운다. 네모 상한(폭 1536·높이 3000)은 네모 자르기와 같다.
 *
 * 여유(`AUTO_PAD`)는 다각형을 굵게 **덧그려서** 준다: 같은 그림을 무늬로 깔고
 * 안을 채운 뒤 테두리를 여유 두께로 한 번 더 긋는다. 꼭짓점을 바깥으로 미는
 * 방식은 오목한 모양(ㄱ자)에서 틀리지만 이건 어느 모양에서든 고르게 넓어진다.
 */
function cropPolygon(img: HTMLImageElement, poly: DetectedKoreanPolygon): string {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const pad = AUTO_PAD * Math.max(W, H);
  const x0 = Math.max(0, poly.box.x * W - pad);
  const y0 = Math.max(0, poly.box.y * H - pad);
  const x1 = Math.min(W, (poly.box.x + poly.box.w) * W + pad);
  const y1 = Math.min(H, (poly.box.y + poly.box.h) * H + pad);
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const s = Math.min(1, PROBLEM_INPUT_DIM / bw, PROBLEM_MAX_HEIGHT / bh);
  const cw = Math.max(1, Math.round(bw * s));
  const ch = Math.max(1, Math.round(bh * s));

  // 잘라 낸 네모(무늬로 쓸 것)와 흰 바탕의 결과 캔버스는 크기가 같아야 무늬가 제자리에 깔린다.
  const src = document.createElement("canvas");
  src.width = cw;
  src.height = ch;
  src.getContext("2d")!.drawImage(img, x0, y0, bw, bh, 0, 0, cw, ch);

  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("캔버스를 만들 수 없습니다.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cw, ch);
  const path = new Path2D();
  poly.points.forEach((p, i) => {
    const px = (p.x * W - x0) * s;
    const py = (p.y * H - y0) * s;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  });
  path.closePath();
  const pattern = ctx.createPattern(src, "no-repeat");
  if (!pattern) throw new Error("캔버스를 만들 수 없습니다.");
  ctx.fillStyle = pattern;
  ctx.fill(path);
  ctx.strokeStyle = pattern;
  ctx.lineWidth = pad * s * 2;
  ctx.lineJoin = "round";
  ctx.stroke(path);
  return out.toDataURL("image/jpeg", 0.9);
}

/** 찾은 다각형을 읽는 차례(왼쪽 단 위→아래, 그다음 오른쪽 단)로. */
function byReadingOrder<T extends { box: { x: number; y: number; w: number } }>(list: T[]): T[] {
  const col = (r: T) => (r.box.x + r.box.w / 2 < 0.5 ? 0 : 1);
  return [...list].sort((a, b) => col(a) - col(b) || a.box.y - b.box.y);
}

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

/** 찾은 지문 조각을 네모로. 읽는 차례(왼쪽 단 위→아래, 그다음 오른쪽 단)로 늘어놓는다. */
function passageBoxesFrom(regions: DetectedKoreanRegion[]): EditBox[] {
  const col = (r: DetectedKoreanRegion) => (r.box.x + r.box.w / 2 < 0.5 ? 0 : 1);
  return regions
    .filter((r) => r.kind === "passage")
    .sort((a, b) => col(a) - col(b) || a.box.y - b.box.y)
    .map((r) => {
      const x = Math.max(0, r.box.x - AUTO_PAD);
      const y = Math.max(0, r.box.y - AUTO_PAD);
      return {
        id: crypto.randomUUID(),
        x,
        y,
        w: Math.min(1 - x, r.box.w + AUTO_PAD * 2),
        h: Math.min(1 - y, r.box.h + AUTO_PAD * 2),
        group: PASSAGE_GROUP,
      };
    });
}

type Detector = {
  provider: "openai" | "gemini";
  model: string;
  effort: string;
  shape: "box" | "polygon";
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
      /** 네모로 찾았을 때의 지문 자리. */
      passages: EditBox[];
      /** 다각형으로 찾았을 때. 둘 중 하나만 찬다. */
      passagePolys: DetectedKoreanPolygon[];
      questionPolys: DetectedKoreanPolygon[];
      questions: number;
    }
  | { state: "error"; ms: number; message: string }
);

async function readReference(image: string): Promise<string> {
  const res = await fetch("/api/mathpix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  });
  const json = (await res.json()) as { text?: string; latex?: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? "Mathpix 가 읽지 못했습니다.");
  return (json.text || json.latex || "").trim();
}

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

/** 칸 머리글·PDF 제목. 고른 모델을 그대로 따라간다(칸에서 바꿀 수 있어서). */
function readerTitle(r: Reader): string {
  return r.provider === "openai" && r.effort ? `${r.model} · ${r.effort}` : r.model;
}

export default function CompareKoreanPage() {
  const [readers, setReaders] = useState<Reader[]>(DEFAULT_READERS);
  // 기본은 운영과 같은 값(gpt-6-luna medium, `OPENAI_DETECT_EFFORT`).
  const [detector, setDetector] = useState<Detector>({
    provider: "openai",
    model: "gpt-6-luna",
    effort: "medium",
    shape: "polygon",
  });
  /** 다각형으로 잡은 지문 자리. 있으면 네모 대신 이걸로 자른다. */
  const [polys, setPolys] = useState<DetectedKoreanPolygon[] | null>(null);
  /** 같이 찾은 문제 자리 — 잘 찾았는지 눈으로 보라고 겹쳐 그리기만 한다. */
  const [questionPolys, setQuestionPolys] = useState<DetectedKoreanPolygon[]>([]);
  const [detectRuns, setDetectRuns] = useState<DetectRun[]>([]);
  const [file, setFile] = useState<File | null>(null);
  /** 네모를 그릴 화면용 사진(긴 변 1600). 자르는 건 원본에서 한다. */
  const [preview, setPreview] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<EditBox[]>([]);
  /** 실제로 두 모델에 보낸 그림 — 무엇을 견줬는지 눈으로 확인한다. */
  const [sent, setSent] = useState<string | null>(null);
  const [useReference, setUseReference] = useState(true);
  /** Mathpix 결과. **보낸 그림과 짝으로** 든다 — 네모를 고치면 다시 읽어야 한다. */
  const [reference, setReference] = useState<{ image: string; text: string } | null>(null);
  const [refState, setRefState] = useState<"idle" | "running" | "ok" | "failed" | "off">("idle");
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
    setPolys(null);
    setQuestionPolys([]);
    setDetectRuns([]);
    setSent(null);
    setReference(null);
    setRefState("idle");
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
    const label =
      (d.provider === "openai" && d.effort ? `${d.model} · ${d.effort}` : d.model) +
      (d.shape === "polygon" ? " · 다각형" : " · 네모");
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
          shape: d.shape,
        }),
      });
      let json = (await res.json().catch(() => ({}))) as ReadResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.jobId) json = await waitForJob(json.jobId, "detect", d.shape);
      const regions = json.regions ?? [];
      const passages = passageBoxesFrom(regions);
      const polygons = json.polygons ?? [];
      const passagePolys = byReadingOrder(polygons.filter((p) => p.kind === "passage"));
      const questionPolysFound = byReadingOrder(polygons.filter((p) => p.kind === "question"));
      settle({
        id,
        label,
        since,
        state: "done",
        ms: Date.now() - since,
        usage: json.usage,
        estKrw: json.estKrw ?? null,
        passages,
        passagePolys,
        questionPolys: questionPolysFound,
        questions:
          d.shape === "polygon"
            ? questionPolysFound.length
            : regions.filter((r) => r.kind === "question").length,
      });
      if (passagePolys.length > 0) {
        setPolys(passagePolys);
        setQuestionPolys(questionPolysFound);
      } else if (passages.length > 0) {
        setPolys(null);
        setQuestionPolys([]);
        setBoxes(passages);
      }
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

  async function runOne(reader: Reader, image: string, ref: string) {
    const since = Date.now();
    setResults((r) => ({ ...r, [reader.key]: { state: "running", since } }));
    try {
      const res = await fetch("/api/admin/compare-korean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          reference: ref,
          provider: reader.provider,
          model: reader.model,
          effort: reader.provider === "openai" ? reader.effort : "",
        }),
      });
      let json = (await res.json().catch(() => ({}))) as ReadResponse;
      if (!res.ok) {
        throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { ms: json.ms });
      }
      // OpenAI 는 백그라운드로 걸려 id 만 온다 — 끝날 때까지 몇 초마다 물어본다.
      // 함수 한도(300초)에 안 묶이므로 max 강도도 끝까지 기다릴 수 있다.
      if (json.jobId) json = await waitForJob(json.jobId);
      const raw = readRichBlocks(json.blocks);
      if (raw.length === 0) throw new Error("문단을 하나도 읽지 못했습니다.");
      // 운영과 똑같이 원문자를 참고 글에 맞춘다 — 여기만 다르면 견준 결과가 운영과 어긋난다.
      const { blocks, replaced, matched } = alignCircledToReference(raw, ref);
      const model = json.model ?? reader.model;
      const tag = reader.provider === "openai" && reader.effort ? `${model} (${reader.effort})` : model;
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
          circledFixed: replaced,
          circledMismatch: !matched,
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
      const image = await passageImage(file, boxes, polys);
      setSent(image);
      let ref = "";
      if (useReference) {
        if (reference?.image === image) {
          ref = reference.text;
          setRefState("ok");
        } else {
          setRefState("running");
          try {
            ref = await readReference(image);
            setReference({ image, text: ref });
            setRefState("ok");
          } catch {
            setRefState("failed");
          }
        }
      } else {
        setRefState("off");
      }
      // 두 모델을 동시에 — 각자 제 요청이라 한쪽이 늦어도 다른 쪽을 막지 않는다.
      await Promise.all(readers.map((r) => runOne(r, image, ref)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">국어 지문 인식 모델 비교</h1>
        <p className="mt-1 text-sm text-slate-600">
          같은 지문 사진을 두 모델에 똑같이 보내고 평가원 양식 PDF 를 각각 뽑습니다. 운영과
          같은 프롬프트·Mathpix 참고 글·원문자 교정을 씁니다. 토큰은 차감하지 않습니다
          (무제한 계정 전용).
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
              모델·강도·모양을 바꿔 여러 번 돌려 견줄 수 있어요. <b>네모(운영)</b>는 지금 국어
              모드의 자동 찾기와 같고, <b>다각형</b>은 테두리를 꺾인 모양 그대로 따라 잡습니다.
              끝나면 찾은 자리가 아래 사진에 들어가요.
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
              <div className="flex gap-1">
                {(["polygon", "box"] as const).map((sh) => (
                  <button
                    key={sh}
                    type="button"
                    onClick={() => setDetector((d) => ({ ...d, shape: sh }))}
                    className={`rounded-lg border px-2 py-1 ${
                      detector.shape === sh
                        ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {sh === "polygon" ? "다각형" : "네모(운영)"}
                  </button>
                ))}
              </div>
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
                          지문 {run.passagePolys.length || run.passages.length}조각 · 문제{" "}
                          {run.questions}개
                        </span>
                        {(run.passagePolys.length > 0 || run.passages.length > 0) && (
                          <button
                            type="button"
                            onClick={() => {
                              if (run.passagePolys.length > 0) {
                                setPolys(run.passagePolys);
                                setQuestionPolys(run.questionPolys);
                              } else {
                                setPolys(null);
                                setQuestionPolys([]);
                                setBoxes(run.passages);
                              }
                            }}
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
        {preview && polys && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-600">
              ② 찾은 <b className="text-emerald-700">지문</b>(초록)을 테두리 모양 그대로 떼어
              내 읽는 차례대로 이어 붙입니다. 바깥은 흰색으로 지워요.{" "}
              <b className="text-blue-700">문제</b>(파랑)는 잘 찾았는지 보라고 겹쳐 그리기만
              합니다.
            </p>
            <div className="relative max-w-xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="지면" className="block w-full rounded border" />
              <svg
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                {questionPolys.map((p, i) => (
                  <polygon
                    key={`q${i}`}
                    points={p.points.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                    fill="rgba(37,99,235,0.10)"
                    stroke="#2563eb"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {polys.map((p, i) => (
                  <polygon
                    key={`p${i}`}
                    points={p.points.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                    fill="rgba(5,150,105,0.14)"
                    stroke="#059669"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>
                지문 {polys.length}조각(꼭짓점 {polys.map((p) => p.points.length).join("·")}개) ·
                문제 {questionPolys.length}개
              </span>
              <button
                type="button"
                onClick={() => {
                  setPolys(null);
                  setQuestionPolys([]);
                }}
                className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-100"
              >
                다각형 버리고 네모로 직접 그리기
              </button>
            </div>
          </div>
        )}
        {preview && !polys && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-600">
              ② 사진 위에 <b>지문 영역</b>을 끌어서 네모로 그리세요(발문 줄부터 지문 끝까지,
              문항은 빼고). 단이나 쪽을 넘는 지문은 조각마다 그리면 <b>그린 차례대로</b>{" "}
              세로로 이어 붙입니다. 안 그리면 사진 전체를 보냅니다.
            </p>
            <div className="max-w-xl">
              <BoxEditor
                image={preview}
                boxes={boxes}
                onChange={setBoxes}
                color="#059669"
                newGroup={PASSAGE_GROUP}
                labelOf={() => "지문"}
              />
            </div>
            <p className="text-xs text-slate-500">
              {boxes.length === 0 ? "네모 없음 — 사진 전체" : `네모 ${boxes.length}개`}
            </p>
          </div>
        )}
        {sent && (
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500">
              두 모델에 실제로 보낸 그림 보기
            </summary>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sent} alt="보낸 지문" className="mt-2 max-h-[32rem] w-auto rounded border" />
          </details>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={useReference}
            onChange={(e) => setUseReference(e.target.checked)}
          />
          Mathpix 참고 글 붙이기(운영과 같음, 1회만 읽어 두 모델에 같이 줌)
        </label>
        {refState !== "idle" && (
          <p className="text-xs text-slate-500">
            Mathpix:{" "}
            {refState === "running"
              ? "읽는 중…"
              : refState === "ok"
                ? `✓ ${reference?.text.length ?? 0}자`
                : refState === "off"
                  ? "끔 — 사진만 보고 읽음"
                  : "실패 — 사진만 보고 읽음"}
          </p>
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
              <div className="flex flex-wrap gap-2 text-xs">
                <div className="flex w-full gap-1">
                  {(["openai", "gemini"] as const).map((pv) => (
                    <button
                      key={pv}
                      type="button"
                      onClick={() =>
                        patchReader(reader.key, {
                          provider: pv,
                          model: pv === "openai" ? OPENAI_PRESETS[0] : "gemini-3.8-flash",
                          effort: pv === "openai" ? "max" : "",
                        })
                      }
                      className={`rounded-lg border px-2 py-1 ${
                        reader.provider === pv
                          ? "border-slate-800 bg-slate-800 text-white"
                          : "border-slate-300 text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      {pv === "openai" ? "OpenAI" : "Gemini"}
                    </button>
                  ))}
                </div>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-slate-600">
                  모델 ({reader.provider === "openai" ? "OpenAI" : "Gemini"})
                  <input
                    value={reader.model}
                    onChange={(e) => patchReader(reader.key, { model: e.target.value })}
                    className="rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </label>
                {reader.provider === "openai" && (
                  <div className="flex w-full flex-wrap gap-1">
                    {OPENAI_PRESETS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => patchReader(reader.key, { model: m })}
                        className={`rounded-lg border px-2 py-1 font-mono ${
                          reader.model === m
                            ? "border-blue-600 bg-blue-50 text-blue-700"
                            : "border-slate-300 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
                {reader.provider === "openai" && (
                  <label className="flex w-28 flex-col gap-1 text-slate-600">
                    추론 강도
                    <input
                      value={reader.effort}
                      onChange={(e) => patchReader(reader.key, { effort: e.target.value })}
                      className="rounded border border-slate-300 px-2 py-1 font-mono"
                    />
                  </label>
                )}
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
        {busy ? "읽는 중…" : "둘 다 읽고 PDF 만들기"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}

function ResultView({ result }: { result: Result }) {
  if (result.state === "idle") return <p className="text-xs text-slate-400">아직 안 돌렸어요.</p>;
  if (result.state === "running") return <Elapsed since={result.since} />;
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
        <li>
          원문자:{" "}
          {result.circledMismatch
            ? "참고 글과 개수가 달라 일부 그대로 둠"
            : `참고 글에 맞춰 ${result.circledFixed}자 고침`}
        </li>
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
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  // 1초마다 다시 그려 경과 시간을 보여 준다.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="text-sm text-slate-500">읽는 중… {Math.round((Date.now() - since) / 1000)}초</p>
  );
}
