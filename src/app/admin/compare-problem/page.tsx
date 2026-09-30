"use client";

import { useState } from "react";
import { fileToDataUrl, loadImage } from "@/lib/cropImage";
import { imageSizeOf, prepareProblemForModel } from "@/lib/figureImage";
import { correctionInstruction, type TextDiff } from "@/lib/problemCompare";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * **문제 글자 정확도 비교** — 무제한 계정 전용 시험 화면.
 *
 * 2026-09-30 사용자 요청. 문제 사진 한 장을 세 갈래로 견준다:
 *
 *  - **지금 운영**: sunburst 가 문제를 통째로 한 번 그린다(`quality` 안 보냄 — 모델
 *    기본값). 남은 글자 차이는 sol 대조로 잰다 — 이 대조는 **측정용**이라 이 줄의
 *    비용·시간에 안 넣는다.
 *  - **① sunburst 단독**: 운영과 같은 한 번 그리기인데 `quality`·출력 크기를 **①만의
 *    값으로** 보낸다. "품질만 올려도 글자가 나아지는가".
 *  - **② 검수 후 다시 그리기**: **②만의 quality·크기**로 그린 뒤 sol 이 원본과 대조해
 *    다른 곳이 있으면 그 목록을 지시로 붙여 한 번 더 그리고, 다시 대조해 차이가 적은
 *    쪽을 남긴다. 대조가 방식의 일부라 비용·시간에 든다.
 *
 * ① 과 ② 의 품질·크기는 서로 독립이다(사용자 — "sunburst 추론강도를 1번과 2번 다르게
 * 만들 수 있게"). 그래서 ② 는 운영 결과를 재사용하지 않고 **자기 값으로 처음부터**
 * 그린다. (③ "sol 이 옮겨 적고 조판" 은 폐기했다 — git 이력에 있다.)
 *
 * 모든 줄이 **같은 대조 프롬프트**로 센 차이다 — 잣대가 같아야 견줄 수 있다.
 * 시간은 화면에서 잰 벽시계 시간(네트워크 포함)이다. 토큰은 차감하지 않는다.
 */

const SOL_MODELS = ["gpt-6.1-sol", "gpt-6-sol"];
const EFFORTS = ["low", "medium", "high"];
/** sunburst 출력 품질. 운영은 아무것도 안 보낸다(모델 기본값). */
const QUALITIES = ["high", "xhigh", "max", "medium", "low", "auto"];
/** 출력 캔버스. "auto" 는 운영과 같이 입력 비율에 맞춘다. 2048x2048 은 사용자가 확인해 준 값. */
const OUTPUT_SIZES = ["auto", "2048x2048"];

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

type Gen = { quality?: string; size?: string };

type Track1 = {
  steps: Step[];
  img?: string;
  diffs?: TextDiff[];
  error?: string;
  totals?: Totals;
};

type Track2 = {
  steps: Step[];
  img1?: string;
  img2?: string;
  diffs1?: TextDiff[];
  diffs2?: TextDiff[];
  pick?: 1 | 2;
  error?: string;
  totals?: Totals;
};

type TrackBase = {
  steps: Step[];
  img?: string;
  diffs?: TextDiff[];
  error?: string;
  totals?: Totals;
};

type HistoryRow = {
  name: string;
  base?: Totals;
  m1?: Totals;
  m1Label?: string;
  m2?: Totals;
  m2Label?: string;
};
type Which = "all" | "base1" | "2";

/** 백그라운드 sol 작업이 끝날 때까지 기다린다. */
async function waitJob<T>(jobId: string): Promise<T> {
  const until = Date.now() + 20 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let poll: { status?: string; message?: string; error?: string } & T;
    try {
      const res = await fetch(`/api/admin/compare-problem?id=${encodeURIComponent(jobId)}&task=verify`, {
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

/** "quality=xhigh · 2048x2048" — 요약·기록에 붙는 이름표. */
const genLabel = (g: Gen) =>
  `quality=${g.quality ?? "기본"}${g.size && g.size !== "auto" ? ` · ${g.size}` : ""}`;

export default function CompareProblemPage() {
  const [name, setName] = useState("");
  const [prepared, setPrepared] = useState<string | null>(null);
  const [solModel, setSolModel] = useState(SOL_MODELS[0]);
  const [effort, setEffort] = useState("medium");
  const [retry, setRetry] = useState(true);
  /** ① 과 ② 는 서로 독립이다. */
  const [g1, setG1] = useState<Gen>({ quality: "xhigh", size: "auto" });
  const [g2, setG2] = useState<Gen>({ quality: "high", size: "auto" });
  const [tb, setTb] = useState<TrackBase>({ steps: [] });
  const [t1, setT1] = useState<Track1>({ steps: [] });
  const [t2, setT2] = useState<Track2>({ steps: [] });
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 요약 표에 쓸 이번 판의 이름표(돌린 시점의 값). */
  const [labels, setLabels] = useState<{ m1: string; m2: string }>({ m1: "", m2: "" });

  async function pick(f: File | null) {
    setPrepared(null);
    setError(null);
    setTb({ steps: [] });
    setT1({ steps: [] });
    setT2({ steps: [] });
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

  async function generate(image: string, g: Gen, instruction?: string) {
    const size = await imageSizeOf(image);
    const out = await postJson<GenResponse>({
      task: "generate",
      image,
      mode: "problem",
      instruction,
      quality: g.quality,
      outputSize: g.size && g.size !== "auto" ? g.size : undefined,
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
    const out = await waitJob<VerifyResponse>(jobId);
    return { value: out.diffs, krw: out.estKrw, note: `차이 ${out.diffs.length}곳` };
  }

  /** 지금 운영 — quality 를 안 보내고 한 번 그린다. */
  async function runBase(image: string): Promise<Pick<HistoryRow, "base">> {
    const steps: Step[] = [];
    const set = (fn: (s: Step[]) => Step[]) => {
      const next = fn(steps);
      steps.splice(0, steps.length, ...next);
      setTb((t) => ({ ...t, steps: [...next] }));
    };
    setTb({ steps: [] });
    try {
      const img = await step(set, "그리기 (sunburst · quality 안 보냄)", () => generate(image, {}));
      setTb((t) => ({ ...t, img }));
      const diffs = await step(set, `대조 (${solModel} ${effort}) — 측정용`, () => verify(image, img), true);
      const totals = sumSteps(steps, diffs.length);
      setTb((t) => ({ ...t, diffs, totals }));
      return { base: totals };
    } catch (err) {
      setTb((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      return {};
    }
  }

  /** ① — 운영과 같은 한 번 그리기에 ① 의 quality·크기만 다르게. */
  async function run1(image: string, g: Gen): Promise<Pick<HistoryRow, "m1" | "m1Label">> {
    const steps: Step[] = [];
    const set = (fn: (s: Step[]) => Step[]) => {
      const next = fn(steps);
      steps.splice(0, steps.length, ...next);
      setT1((t) => ({ ...t, steps: [...next] }));
    };
    setT1({ steps: [] });
    try {
      const img = await step(set, `그리기 (sunburst · ${genLabel(g)})`, () => generate(image, g));
      setT1((t) => ({ ...t, img }));
      const diffs = await step(set, `대조 (${solModel} ${effort}) — 측정용`, () => verify(image, img), true);
      const totals = sumSteps(steps, diffs.length);
      setT1((t) => ({ ...t, diffs, totals }));
      return { m1: totals, m1Label: genLabel(g) };
    } catch (err) {
      setT1((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      return {};
    }
  }

  /** ② — ② 의 quality·크기로 그리고, 대조해서 틀린 곳이 있으면 지시로 붙여 한 번 더. */
  async function run2(image: string, g: Gen): Promise<Pick<HistoryRow, "m2" | "m2Label">> {
    const steps: Step[] = [];
    const set = (fn: (s: Step[]) => Step[]) => {
      const next = fn(steps);
      steps.splice(0, steps.length, ...next);
      setT2((t) => ({ ...t, steps: [...next] }));
    };
    setT2({ steps: [] });
    try {
      const img1 = await step(set, `그리기 1 (sunburst · ${genLabel(g)})`, () => generate(image, g));
      setT2((t) => ({ ...t, img1 }));
      const diffs1 = await step(set, `대조 1 (${solModel} ${effort})`, () => verify(image, img1));
      setT2((t) => ({ ...t, diffs1 }));
      if (diffs1.length === 0 || !retry) {
        const totals = sumSteps(steps, diffs1.length);
        setT2((t) => ({ ...t, pick: 1, totals }));
        return { m2: totals, m2Label: genLabel(g) };
      }
      const img2 = await step(set, `그리기 2 (같은 값 · 틀린 곳을 지시로 붙여)`, () =>
        generate(image, g, correctionInstruction(diffs1)),
      );
      setT2((t) => ({ ...t, img2 }));
      const diffs2 = await step(set, `대조 2 (${solModel} ${effort})`, () => verify(image, img2));
      const pickN: 1 | 2 = diffs2.length <= diffs1.length ? 2 : 1;
      const totals = sumSteps(steps, Math.min(diffs1.length, diffs2.length));
      setT2((t) => ({ ...t, diffs2, pick: pickN, totals }));
      return { m2: totals, m2Label: genLabel(g) };
    } catch (err) {
      setT2((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      return {};
    }
  }

  async function runAll(which: Which) {
    if (!prepared || busy) return;
    setBusy(true);
    setError(null);
    setLabels({ m1: genLabel(g1), m2: genLabel(g2) });
    // 안 돌리는 칸은 비운다 — 지난 결과가 남으면 이번 것과 섞여 보인다.
    if (which === "2") {
      setTb({ steps: [] });
      setT1({ steps: [] });
    } else if (which === "base1") {
      setT2({ steps: [] });
    }
    try {
      const [a, b, c] = await Promise.all([
        which !== "2" ? runBase(prepared) : Promise.resolve({}),
        which !== "2" ? run1(prepared, g1) : Promise.resolve({}),
        which !== "base1" ? run2(prepared, g2) : Promise.resolve({}),
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
          문제 사진 한 장으로 <b>지금 운영</b>(sunburst 가 통째로 그림, quality 안 보냄) ·{" "}
          <b>① 같은 그리기에 quality·크기만 다르게</b> · <b>② 검수 후 다시 그리기</b>(② 만의 quality·크기)를
          돌려 시간·원가·남은 글자 차이를 견줍니다. ① 과 ② 의 값은 서로 독립입니다. 차이는 셋 다 같은 sol
          대조로 셉니다. 토큰은 차감하지 않습니다(무제한 계정 전용).
        </p>
      </div>

      <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          문제 사진 (문제 하나만 잘라 둔 것)
          <input type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="text-sm" />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <GenPicker title="① sunburst 단독" value={g1} onChange={setG1} />
          <GenPicker title="② 검수 후 다시 그리기" value={g2} onChange={setG2} />
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            대조 sol 모델
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
            <input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} />② 차이가 있으면 한 번 다시 그리기
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!prepared || busy} onClick={() => runAll("all")}>
            {busy ? "돌리는 중…" : "전부 돌리기"}
          </Button>
          <Button variant="outline" disabled={!prepared || busy} onClick={() => runAll("base1")}>
            운영 vs ①
          </Button>
          <Button variant="outline" disabled={!prepared || busy} onClick={() => runAll("2")}>
            ②만
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

      {(tb.totals || t1.totals || t2.totals) && (
        <Summary base={tb.totals} m1={t1.totals} m1Label={labels.m1} m2={t2.totals} m2Label={labels.m2} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <section className={cn(cardClass, "flex min-w-0 flex-col gap-3 p-4")}>
          <h2 className="font-semibold text-ink">지금 운영</h2>
          <Steps steps={tb.steps} />
          {tb.error && <p className="text-sm text-red-600">{tb.error}</p>}
          {tb.img && <Shot title="그리기 (quality 안 보냄)" src={tb.img} diffs={tb.diffs} />}
        </section>

        <section className={cn(cardClass, "flex min-w-0 flex-col gap-3 p-4")}>
          <h2 className="font-semibold text-ink">① sunburst 단독{labels.m1 && ` · ${labels.m1}`}</h2>
          <Steps steps={t1.steps} />
          {t1.error && <p className="text-sm text-red-600">{t1.error}</p>}
          {t1.img && <Shot title="그리기" src={t1.img} diffs={t1.diffs} />}
        </section>

        <section className={cn(cardClass, "flex min-w-0 flex-col gap-3 p-4")}>
          <h2 className="font-semibold text-ink">② 검수 후 다시 그리기{labels.m2 && ` · ${labels.m2}`}</h2>
          <Steps steps={t2.steps} />
          {t2.error && <p className="text-sm text-red-600">{t2.error}</p>}
          {t2.img1 && (
            <Shot title={`그리기 1${t2.pick === 1 ? " · 최종" : ""}`} src={t2.img1} diffs={t2.diffs1} />
          )}
          {t2.img2 && (
            <Shot title={`그리기 2${t2.pick === 2 ? " · 최종" : ""}`} src={t2.img2} diffs={t2.diffs2} />
          )}
        </section>
      </div>

      {history.length > 0 && <History rows={history} />}
    </main>
  );
}

/** 한 방식의 sunburst 품질·출력 크기 고르기. */
function GenPicker({ title, value, onChange }: { title: string; value: Gen; onChange: (g: Gen) => void }) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <legend className="px-1 text-xs font-semibold text-slate-600">{title}</legend>
      <label className="flex items-center gap-1.5">
        quality
        <select
          value={value.quality}
          onChange={(e) => onChange({ ...value, quality: e.target.value })}
          className="rounded border px-2 py-1 font-mono text-xs"
        >
          {QUALITIES.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        출력 크기
        <select
          value={value.size}
          onChange={(e) => onChange({ ...value, size: e.target.value })}
          className="rounded border px-2 py-1 font-mono text-xs"
        >
          {OUTPUT_SIZES.map((m) => (
            <option key={m} value={m}>
              {m === "auto" ? "운영과 같게(비율 맞춤)" : m}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
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

function Summary({
  base,
  m1,
  m1Label,
  m2,
  m2Label,
}: {
  base?: Totals;
  m1?: Totals;
  m1Label?: string;
  m2?: Totals;
  m2Label?: string;
}) {
  const rows = [
    { label: "지금 운영", t: base, note: "quality 안 보냄 · 대조는 측정용" },
    { label: `① ${m1Label ?? ""}`, t: m1, note: "그리기 1번 · 대조는 측정용" },
    { label: `② ${m2Label ?? ""}`, t: m2, note: "대조가 방식에 포함" },
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
  const cols: [string, (r: HistoryRow) => Totals | undefined, (r: HistoryRow) => string | undefined][] = [
    ["지금 운영", (r) => r.base, () => undefined],
    ["①", (r) => r.m1, (r) => r.m1Label],
    ["②", (r) => r.m2, (r) => r.m2Label],
  ];
  const cell = (t: Totals | undefined, label?: string) =>
    t ? `${label ? `[${label}] ` : ""}${secs(t.ms)} · ${won(t.krw)} · ${t.diffs ?? "?"}곳` : "—";
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
              {cols.map(([l, p, lab]) => (
                <td key={l} className="tabular-nums">
                  {cell(p(r), lab(r))}
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
      <p className="mt-2 text-xs text-slate-400">
        새로고침하면 사라져요. 원가는 공표 단가로 계산한 값이에요. ①·② 는 돌릴 때마다 quality·크기를 바꿀 수
        있으니 [ ] 안의 값을 함께 보세요.
      </p>
    </section>
  );
}
