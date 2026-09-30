"use client";

import { useState } from "react";
import { fileToDataUrl, cropImageToDataUrl, loadImage } from "@/lib/cropImage";
import {
  imageSizeOf,
  MODEL_INPUT_DIM,
  prepareFigureForModel,
  prepareProblemForModel,
  rasterToSvg,
  trimBlankBorder,
} from "@/lib/figureImage";
import { renderMathTextWithInfo } from "@/lib/renderMathText";
import { buildAnchors, cardHtmlFromSpec, type CardFigure, type CardSpec } from "@/lib/cardHtml";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import { PROBLEM_CARD_WIDTH } from "@/lib/layout";
import {
  correctionInstruction,
  splitFigureMarkers,
  type TextDiff,
  type TranscribedFigure,
} from "@/lib/problemCompare";
import ScaledCard from "@/components/ScaledCard";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * **문제 글자 정확도 비교** — 무제한 계정 전용 시험 화면.
 *
 * 2026-09-30 사용자 요청 — "2번과 3번을 테스트해서 대조 가능한 창을 만들어 보고
 * 비용·소요 시간을 재 보자". 문제 사진 한 장을 세 갈래로 견준다:
 *
 *  - **지금 운영**: sunburst 가 문제를 통째로 그린다(한 번). 남은 글자 차이는 sol
 *    대조로 잰다 — 이 대조는 **측정용**이라 이 줄의 비용·시간에 안 넣는다.
 *  - **② 검수 후 다시 그리기**: 위 결과를 sol 이 대조해 다른 곳이 있으면 그 목록을
 *    지시로 붙여 한 번 더 그리고, 다시 대조해 차이가 적은 쪽을 남긴다.
 *  - **③ sol 이 옮겨 적고 우리가 조판**: sol 이 본문을 글자·LaTeX 로 옮기고 그림
 *    자리를 짚는다. 그림은 잘라 내(켜면 sunburst 로 다시 그려) 카드에 붙인다.
 *    조판한 카드를 같은 대조로 잰다(측정용).
 *
 *  - **① sunburst 단독 · quality 올림**: 운영과 같은 한 번 그리기인데 `quality` 만
 *    보낸다(운영은 안 보낸다 — 모델 기본값). "품질만 올려도 글자가 나아지는가"를
 *    운영 줄과 나란히 잰다. 대조는 역시 측정용이다(2026-09-30 사용자 요청).
 *
 * 모든 줄이 **같은 대조 프롬프트**로 센 차이다 — 잣대가 같아야 견줄 수 있다.
 * 시간은 화면에서 잰 벽시계 시간(네트워크 포함)이다. 토큰은 차감하지 않는다.
 */

const SOL_MODELS = ["gpt-6.1-sol", "gpt-6-sol"];
const EFFORTS = ["low", "medium", "high"];
/** sunburst 출력 품질. 운영은 아무것도 안 보낸다(모델 기본값). */
const QUALITIES = ["high", "medium", "low", "auto"];

type Step = {
  label: string;
  state: "running" | "done" | "error";
  ms?: number;
  krw?: number | null;
  note?: string;
  /** 측정용(방식 자체의 비용·시간에는 안 넣는다). */
  measure?: boolean;
};

type Totals = { ms: number; krw: number; measureKrw: number; diffs: number | null; unknownCost: boolean };

type Track2 = {
  steps: Step[];
  img1?: string;
  img2?: string;
  diffs1?: TextDiff[];
  diffs2?: TextDiff[];
  pick?: 1 | 2;
  error?: string;
  baseline?: Totals;
  totals?: Totals;
};

type Track1 = {
  steps: Step[];
  img?: string;
  diffs?: TextDiff[];
  error?: string;
  totals?: Totals;
};

type Track3 = {
  steps: Step[];
  text?: string;
  raw?: string;
  cardHtml?: string;
  figures?: number;
  diffs?: TextDiff[];
  error?: string;
  totals?: Totals;
};

type HistoryRow = { name: string; baseline?: Totals; m1?: Totals; m1Quality?: string; m2?: Totals; m3?: Totals };
type Which = "all" | "1" | "2" | "3";

/** 백그라운드 sol 작업이 끝날 때까지 기다린다. */
async function waitJob<T>(jobId: string, task: "verify" | "transcribe"): Promise<T> {
  const until = Date.now() + 20 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let poll: { status?: string; message?: string; error?: string } & T;
    try {
      const res = await fetch(`/api/admin/compare-problem?id=${encodeURIComponent(jobId)}&task=${task}`, {
        cache: "no-store",
      });
      poll = await res.json();
    } catch {
      if (Date.now() > until) throw new Error("20분이 지나도 끝나지 않았습니다.");
      continue;
    }
    if (poll.status === "done") return poll;
    if (poll.status === "error") throw new Error(poll.message ?? poll.error ?? "실패했습니다.");
    if (Date.now() > until) throw new Error("20분이 지나도 끝나지 않았습니다.");
  }
}

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/admin/compare-problem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** 요청 본문 한도(4.5MB)를 넘지 않게 JPEG 으로 줄인다(흰 바탕 — JPEG 에는 투명이 없다). */
async function toJpeg(dataUrl: string, maxW = 1536): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("캔버스를 만들지 못했습니다.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.9);
}

type GenResponse = { image: string; model: string; usage: { estKrw: number } | null; ms: number };
type VerifyResponse = { diffs: TextDiff[]; estKrw: number | null };
type TranscribeResponse = { text: string; figures: TranscribedFigure[]; raw: string; estKrw: number | null };

const won = (krw: number | null | undefined) => (krw == null ? "?" : `${Math.round(krw).toLocaleString()}원`);
const secs = (ms: number | undefined) => (ms == null ? "…" : `${(ms / 1000).toFixed(1)}초`);

function sumSteps(steps: Step[], diffs: number | null): Totals {
  const own = steps.filter((s) => !s.measure);
  return {
    ms: own.reduce((a, s) => a + (s.ms ?? 0), 0),
    krw: own.reduce((a, s) => a + (s.krw ?? 0), 0),
    measureKrw: steps.filter((s) => s.measure).reduce((a, s) => a + (s.krw ?? 0), 0),
    diffs,
    unknownCost: own.some((s) => s.state === "done" && s.krw == null),
  };
}

export default function CompareProblemPage() {
  const [name, setName] = useState("");
  const [prepared, setPrepared] = useState<string | null>(null);
  const [solModel, setSolModel] = useState(SOL_MODELS[0]);
  const [effort, setEffort] = useState("medium");
  const [retry, setRetry] = useState(true);
  const [redrawFigures, setRedrawFigures] = useState(true);
  const [quality, setQuality] = useState(QUALITIES[0]);
  const [t1, setT1] = useState<Track1>({ steps: [] });
  const [t2, setT2] = useState<Track2>({ steps: [] });
  const [t3, setT3] = useState<Track3>({ steps: [] });
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(f: File | null) {
    setPrepared(null);
    setError(null);
    setT1({ steps: [] });
    setT2({ steps: [] });
    setT3({ steps: [] });
    if (!f) return;
    setName(f.name);
    try {
      // 운영 "AI로 다시 그리기"와 같은 입력 — 대비를 올리고 폭 1536 기준으로 줄인다.
      setPrepared(await prepareProblemForModel(await fileToDataUrl(f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
    }
  }

  /** 한 단계를 돌리며 시간을 잰다. 끝나면 비용·메모를 채운다. */
  async function step<T>(
    set: (fn: (steps: Step[]) => Step[]) => void,
    label: string,
    fn: () => Promise<{ value: T; krw: number | null; note?: string }>,
    measure = false,
  ): Promise<T> {
    let idx = -1;
    set((s) => {
      idx = s.length;
      return [...s, { label, state: "running", measure }];
    });
    const t0 = performance.now();
    try {
      const { value, krw, note } = await fn();
      const ms = performance.now() - t0;
      set((s) => s.map((x, i) => (i === idx ? { ...x, state: "done", ms, krw, note } : x)));
      return value;
    } catch (err) {
      const ms = performance.now() - t0;
      const note = err instanceof Error ? err.message : String(err);
      set((s) => s.map((x, i) => (i === idx ? { ...x, state: "error", ms, note } : x)));
      throw err;
    }
  }

  async function generate(image: string, mode: "problem" | "figure", instruction?: string, q?: string) {
    const size = await imageSizeOf(image);
    const out = await postJson<GenResponse>({
      task: "generate",
      image,
      mode,
      instruction,
      quality: q,
      width: size?.width,
      height: size?.height,
    });
    return { value: out.image, krw: out.usage?.estKrw ?? null };
  }

  async function verify(original: string, recreated: string) {
    const { jobId } = await postJson<{ jobId: string }>({
      task: "verify",
      original,
      recreated: await toJpeg(recreated),
      model: solModel,
      effort,
    });
    const out = await waitJob<VerifyResponse>(jobId, "verify");
    return { value: out.diffs, krw: out.estKrw, note: `차이 ${out.diffs.length}곳` };
  }

  /** ① — 운영과 같은 한 번 그리기에 quality 만 올린다. */
  async function run1(image: string, q: string): Promise<Pick<HistoryRow, "m1" | "m1Quality">> {
    const steps: Step[] = [];
    const set = (fn: (s: Step[]) => Step[]) => {
      const next = fn(steps);
      steps.splice(0, steps.length, ...next);
      setT1((t) => ({ ...t, steps: [...next] }));
    };
    setT1({ steps: [] });
    try {
      const img = await step(set, `그리기 (sunburst · quality=${q})`, () => generate(image, "problem", undefined, q));
      setT1((t) => ({ ...t, img }));
      const diffs = await step(set, `대조 (${solModel} ${effort}) — 측정용`, () => verify(image, img), true);
      const totals = sumSteps(steps, diffs.length);
      setT1((t) => ({ ...t, diffs, totals }));
      return { m1: totals, m1Quality: q };
    } catch (err) {
      setT1((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      return {};
    }
  }

  /** ② — 지금 운영 한 번 + 검수 후 다시 그리기. `retryOn` 이 거짓이면 운영 한 번만. */
  async function run2(image: string, retryOn: boolean): Promise<Pick<HistoryRow, "baseline" | "m2">> {
    const steps: Step[] = [];
    const set = (fn: (s: Step[]) => Step[]) => {
      const next = fn(steps);
      steps.splice(0, steps.length, ...next);
      setT2((t) => ({ ...t, steps: [...next] }));
    };
    setT2({ steps: [] });
    try {
      const img1 = await step(set, "그리기 1 (sunburst · 문제 통째로)", () => generate(image, "problem"));
      setT2((t) => ({ ...t, img1 }));
      const diffs1 = await step(set, `대조 1 (${solModel} ${effort})`, () => verify(image, img1));
      setT2((t) => ({ ...t, diffs1 }));
      // "지금 운영" 줄 — 그리기 1 만이 방식이고 대조 1 은 측정이다.
      const baseline: Totals = {
        ...sumSteps([steps[0]], diffs1.length),
        measureKrw: steps[1]?.krw ?? 0,
      };
      if (!retryOn) {
        // ② 를 안 돌린 것이다(운영 한 번만) — ② 줄을 만들지 않는다.
        setT2((t) => ({ ...t, pick: 1, baseline }));
        return { baseline };
      }
      if (diffs1.length === 0) {
        const totals = sumSteps(steps, diffs1.length);
        setT2((t) => ({ ...t, pick: 1, baseline, totals }));
        return { baseline, m2: totals };
      }
      const img2 = await step(set, "그리기 2 (틀린 곳을 지시로 붙여)", () =>
        generate(image, "problem", correctionInstruction(diffs1)),
      );
      setT2((t) => ({ ...t, img2 }));
      const diffs2 = await step(set, `대조 2 (${solModel} ${effort})`, () => verify(image, img2));
      const pickN: 1 | 2 = diffs2.length <= diffs1.length ? 2 : 1;
      const totals = sumSteps(steps, Math.min(diffs1.length, diffs2.length));
      setT2((t) => ({ ...t, diffs2, pick: pickN, baseline, totals }));
      return { baseline, m2: totals };
    } catch (err) {
      setT2((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      return {};
    }
  }

  /** ③ — sol 이 옮겨 적고 우리가 조판. */
  async function run3(image: string): Promise<Pick<HistoryRow, "m3">> {
    const steps: Step[] = [];
    const set = (fn: (s: Step[]) => Step[]) => {
      const next = fn(steps);
      steps.splice(0, steps.length, ...next);
      setT3((t) => ({ ...t, steps: [...next] }));
    };
    setT3({ steps: [] });
    try {
      const tr = await step(set, `옮겨 적기 (${solModel} ${effort})`, async () => {
        const { jobId } = await postJson<{ jobId: string }>({
          task: "transcribe",
          image,
          model: solModel,
          effort,
        });
        const out = await waitJob<TranscribeResponse>(jobId, "transcribe");
        return { value: out, krw: out.estKrw, note: `${out.text.length}자 · 그림 ${out.figures.length}개` };
      });
      setT3((t) => ({ ...t, text: tr.text, raw: tr.raw }));

      // 그림: sol 이 짚은 자리를 보낸 사진에서 잘라 낸다(켜면 sunburst 로 다시 그린다).
      const src = await loadImage(image);
      const W = src.naturalWidth;
      const H = src.naturalHeight;
      const crops = tr.figures.map((f) => ({
        f,
        crop: cropImageToDataUrl(src, { x: f.x * W, y: f.y * H, width: f.w * W, height: f.h * H }),
      }));
      let drawn: { f: TranscribedFigure; data: string }[] = crops.map(({ f, crop }) => ({ f, data: crop }));
      if (crops.length > 0) {
        drawn = await step(
          set,
          redrawFigures ? `그림 ${crops.length}개 다시 그리기 (sunburst · 동시에)` : `그림 ${crops.length}개 원본 붙이기`,
          async () => {
            if (!redrawFigures) return { value: drawn, krw: 0 };
            let krw = 0;
            const out = await Promise.all(
              crops.map(async ({ f, crop }) => {
                const forModel = await prepareFigureForModel(crop, MODEL_INPUT_DIM);
                const g = await generate(forModel, "figure");
                krw += g.krw ?? 0;
                return { f, data: await trimBlankBorder(g.value) };
              }),
            );
            return { value: out, krw };
          },
        );
      }

      // 조판 — 운영 카드 조립(`cardHtmlFromSpec`)을 그대로 쓴다.
      const html = await step(set, "조판 (카드 조립 + 캡처)", async () => {
        const { text, markers } = splitFigureMarkers(tr.text);
        const anchorsBefore = (before: string) =>
          before.trim() ? buildAnchors(renderMathTextWithInfo(before).blocks).length - 1 : 0;
        const figures: CardFigure[] = await Promise.all(
          drawn.map(async ({ f, data }) => {
            const m = markers.find((x) => x.id === f.id);
            return {
              id: f.id,
              markup: await rasterToSvg(data),
              // 원본에서 차지하던 폭 비율을 그대로 쓴다.
              layout: { scale: Math.min(100, Math.max(25, Math.round(f.w * 100))), offsetX: 0, offsetY: 12 },
              position: m ? anchorsBefore(m.before) : 9999,
            };
          }),
        );
        const spec: CardSpec = { text, boxOverride: undefined, fontSizePx: ptToPx(DEFAULT_FONT_PT), figures };
        const cardHtml = cardHtmlFromSpec(spec);
        const png = await renderCardOffscreen(spec);
        return { value: { cardHtml, png }, krw: 0 };
      });
      setT3((t) => ({ ...t, cardHtml: html.cardHtml, figures: drawn.length }));

      const diffs = await step(set, `대조 (${solModel} ${effort}) — 측정용`, () => verify(image, html.png), true);
      const totals = sumSteps(steps, diffs.length);
      setT3((t) => ({ ...t, diffs, totals }));
      return { m3: totals };
    } catch (err) {
      setT3((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      return {};
    }
  }

  async function runAll(which: Which) {
    if (!prepared || busy) return;
    setBusy(true);
    setError(null);
    // 안 돌리는 칸은 비운다 — 지난 결과가 남으면 이번 것과 섞여 보인다.
    if (which === "2" || which === "3") setT1({ steps: [] });
    if (which === "3") setT2({ steps: [] });
    if (which === "1" || which === "2") setT3({ steps: [] });
    try {
      // "운영 vs ①" 은 운영 한 번만 돌린다(② 의 다시 그리기는 빼서 값을 아낀다).
      const [a, b, c] = await Promise.all([
        which === "all" || which === "1" ? run1(prepared, quality) : Promise.resolve({}),
        which !== "3" ? run2(prepared, which !== "1" && retry) : Promise.resolve({}),
        which === "all" || which === "3" ? run3(prepared) : Promise.resolve({}),
      ]);
      setHistory((h) => [...h, { name: name || `문제 ${h.length + 1}`, ...a, ...b, ...c }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">문제 글자 정확도 비교</h1>
        <p className="mt-1 text-sm text-slate-600">
          문제 사진 한 장으로 <b>지금 운영</b>(sunburst 가 통째로 그림) · <b>① 같은 그리기에 quality 만 올림</b> ·{" "}
          <b>② 검수 후 다시 그리기</b> · <b>③ sol 이 옮겨 적고 조판</b>을 돌려 시간·원가·남은 글자 차이를 견줍니다. 차이는 셋 다 같은
          sol 대조로 셉니다. 운영은 quality 를 보내지 않습니다(모델 기본값). 토큰은 차감하지 않습니다(무제한 계정 전용).
        </p>
      </div>

      <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          문제 사진 (문제 하나만 잘라 둔 것)
          <input type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="text-sm" />
        </label>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            sol 모델
            <select value={solModel} onChange={(e) => setSolModel(e.target.value)} className="rounded border px-2 py-1 font-mono text-xs">
              {SOL_MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            추론 강도
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className="rounded border px-2 py-1 text-xs">
              {EFFORTS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            ① sunburst quality
            <select value={quality} onChange={(e) => setQuality(e.target.value)} className="rounded border px-2 py-1 font-mono text-xs">
              {QUALITIES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} />② 차이가 있으면 한 번 다시 그리기
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={redrawFigures} onChange={(e) => setRedrawFigures(e.target.checked)} />
            ③ 그림을 sunburst 로 다시 그리기 (끄면 원본 크롭)
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!prepared || busy} onClick={() => runAll("all")}>
            {busy ? "돌리는 중…" : "전부 돌리기"}
          </Button>
          <Button variant="outline" disabled={!prepared || busy} onClick={() => runAll("1")}>
            운영 vs ① quality={quality}
          </Button>
          <Button variant="outline" disabled={!prepared || busy} onClick={() => runAll("2")}>
            운영 + ②만
          </Button>
          <Button variant="outline" disabled={!prepared || busy} onClick={() => runAll("3")}>
            ③만
          </Button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {prepared && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">보낸 사진 보기 (모든 호출이 이 사진을 씁니다)</summary>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={prepared} alt="보낸 사진" className="mt-2 max-h-[480px] rounded border" />
          </details>
        )}
      </section>

      {(t1.totals || t2.baseline || t3.totals) && (
        <Summary
          baseline={t2.baseline}
          m1={t1.totals}
          m1Quality={quality}
          m2={t2.totals}
          m3={t3.totals}
        />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {(t1.steps.length > 0 || t1.error) && (
          <section className={cn(cardClass, "flex min-w-0 flex-col gap-3 p-4")}>
            <h2 className="font-semibold text-ink">① sunburst 단독 · quality 올림</h2>
            <Steps steps={t1.steps} />
            {t1.error && <p className="text-sm text-red-600">{t1.error}</p>}
            {t1.img && <Shot title="그리기 (quality 지정)" src={t1.img} diffs={t1.diffs} />}
          </section>
        )}

        <section className={cn(cardClass, "flex min-w-0 flex-col gap-3 p-4")}>
          <h2 className="font-semibold text-ink">지금 운영 → ② 검수 후 다시 그리기</h2>
          <Steps steps={t2.steps} />
          {t2.error && <p className="text-sm text-red-600">{t2.error}</p>}
          {t2.img1 && (
            <Shot
              title={`그리기 1${t2.pick === 1 ? " · 최종" : ""}`}
              src={t2.img1}
              diffs={t2.diffs1}
            />
          )}
          {t2.img2 && (
            <Shot
              title={`그리기 2${t2.pick === 2 ? " · 최종" : ""}`}
              src={t2.img2}
              diffs={t2.diffs2}
            />
          )}
        </section>

        <section className={cn(cardClass, "flex min-w-0 flex-col gap-3 p-4")}>
          <h2 className="font-semibold text-ink">③ sol 이 옮겨 적고 조판</h2>
          <Steps steps={t3.steps} />
          {t3.error && <p className="text-sm text-red-600">{t3.error}</p>}
          {t3.cardHtml && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-slate-600">조판 결과 (그림 {t3.figures ?? 0}개)</p>
              <ScaledCard width={PROBLEM_CARD_WIDTH}>
                <div
                  className="problem-surface rounded-2xl border border-slate-200 bg-white p-8"
                  style={{ width: PROBLEM_CARD_WIDTH }}
                >
                  <div
                    className="font-serif leading-relaxed text-ink"
                    style={{ fontSize: ptToPx(DEFAULT_FONT_PT) }}
                    dangerouslySetInnerHTML={{ __html: t3.cardHtml }}
                  />
                </div>
              </ScaledCard>
              {t3.diffs && <DiffList diffs={t3.diffs} />}
            </div>
          )}
          {t3.text && (
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500">옮겨 적은 글 / 원본 JSON</summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2">{t3.text}</pre>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-500">
                {t3.raw}
              </pre>
            </details>
          )}
        </section>
      </div>

      {history.length > 0 && <History rows={history} />}
    </main>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return <p className="text-sm text-slate-400">아직 안 돌렸어요.</p>;
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {steps.map((s, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2">
          <span className={s.state === "error" ? "text-red-600" : s.state === "running" ? "text-blue-700" : "text-slate-700"}>
            {s.state === "running" ? "⏳" : s.state === "error" ? "✕" : "✓"} {s.label}
          </span>
          <span className="tabular-nums text-slate-500">
            {secs(s.ms)} · {won(s.krw)}
            {s.measure ? " · 측정용" : ""}
          </span>
          {s.note && <span className="text-xs text-slate-500">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function Shot({ title, src, diffs }: { title: string; src: string; diffs?: TextDiff[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-slate-600">{title}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={title} className="w-full rounded border bg-white" />
      {diffs && <DiffList diffs={diffs} />}
    </div>
  );
}

function DiffList({ diffs }: { diffs: TextDiff[] }) {
  if (diffs.length === 0) return <p className="text-xs font-medium text-emerald-700">대조: 글자 차이 없음</p>;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/60 p-2 text-xs">
      <p className="mb-1 font-semibold text-red-700">대조: 글자 차이 {diffs.length}곳</p>
      <ul className="flex flex-col gap-0.5">
        {diffs.map((d, i) => (
          <li key={i}>
            {d.where && <span className="text-slate-500">[{d.where}] </span>}
            원본 <b>{d.original || "∅"}</b> → <span className="text-red-700">{d.recreated || "(빠짐)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function row(label: string, t: Totals | undefined, note: string) {
  return { label, t, note };
}

function Summary({
  baseline,
  m1,
  m1Quality,
  m2,
  m3,
}: {
  baseline?: Totals;
  m1?: Totals;
  m1Quality?: string;
  m2?: Totals;
  m3?: Totals;
}) {
  const rows = [
    row("지금 운영", baseline, "그리기 1번 · quality 안 보냄"),
    row(`① quality=${m1Quality ?? "?"}`, m1, "그리기 1번 · 대조는 측정용"),
    row("② 검수 후 다시 그리기", m2, "대조가 방식에 포함"),
    row("③ sol 옮겨 적기 + 조판", m3, "마지막 대조는 측정용"),
  ].filter((r) => r.t);
  return (
    <section className={cn(cardClass, "overflow-x-auto p-4")}>
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1">방식</th>
            <th>시간</th>
            <th>원가</th>
            <th>남은 글자 차이</th>
            <th>측정 원가</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t">
              <td className="py-1.5">
                <span className="font-medium text-ink">{r.label}</span>
                <span className="ml-1 text-xs text-slate-400">{r.note}</span>
              </td>
              <td className="tabular-nums">{secs(r.t!.ms)}</td>
              <td className="tabular-nums">
                {won(r.t!.krw)}
                {r.t!.unknownCost ? "+?" : ""}
              </td>
              <td className={cn("tabular-nums font-semibold", r.t!.diffs ? "text-red-700" : "text-emerald-700")}>
                {r.t!.diffs ?? "?"}곳
              </td>
              <td className="tabular-nums text-slate-500">{won(r.t!.measureKrw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function History({ rows }: { rows: HistoryRow[] }) {
  const avg = (pick: (r: HistoryRow) => Totals | undefined, f: (t: Totals) => number | null) => {
    const vals = rows.map(pick).filter((t): t is Totals => !!t).map(f).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const cols: [string, (r: HistoryRow) => Totals | undefined][] = [
    ["지금 운영", (r) => r.baseline],
    ["① quality", (r) => r.m1],
    ["②", (r) => r.m2],
    ["③", (r) => r.m3],
  ];
  const cell = (t: Totals | undefined, q?: string) =>
    t ? `${q ? `[${q}] ` : ""}${secs(t.ms)} · ${won(t.krw)} · ${t.diffs ?? "?"}곳` : "—";
  return (
    <section className={cn(cardClass, "overflow-x-auto p-4")}>
      <h2 className="mb-2 font-semibold text-ink">이번 세션 기록 ({rows.length}문제)</h2>
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1">문제</th>
            {cols.map(([l]) => (
              <th key={l}>{l} (시간 · 원가 · 차이)</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="max-w-[160px] truncate py-1.5">{r.name}</td>
              {cols.map(([l, p]) => (
                <td key={l} className="tabular-nums">
                  {cell(p(r), p === cols[1][1] ? r.m1Quality : undefined)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t font-semibold">
            <td className="py-1.5">평균</td>
            {cols.map(([l, p]) => {
              const ms = avg(p, (t) => t.ms);
              const krw = avg(p, (t) => t.krw);
              const d = avg(p, (t) => t.diffs);
              return (
                <td key={l} className="tabular-nums">
                  {ms == null ? "—" : `${secs(ms)} · ${won(krw)} · ${d == null ? "?" : d.toFixed(1)}곳`}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">새로고침하면 사라져요. 원가는 공표 단가로 계산한 값이에요.</p>
    </section>
  );
}
