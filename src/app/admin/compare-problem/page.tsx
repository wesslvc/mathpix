"use client";

import { useState } from "react";
import { fileToDataUrl, loadImage } from "@/lib/cropImage";
import { imageSizeOf, prepareProblemForModel } from "@/lib/figureImage";
import { accumulatedCorrection, type RoundDiffs, type TextDiff } from "@/lib/problemCompare";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * **sol 이 읽고 sunburst 가 고쳐 그리기** — 무제한 계정 전용 시험 화면.
 *
 * 2026-09-30 사용자 지시 — "sol 이 읽고 sunburst 알아서 그리고 대조하고 다른 거 그리고
 * 이런 식으로. 대조(비교표)는 필요 없어, 이것만 놔두고 퀄리티랑 추론강도 조정만 가능하게".
 *
 * 흐름: sunburst 가 **가장 낮은 quality 로** 문제를 통째로 그린다 → sol 이 원본과 대조해 글자가
 * 다른 곳을 찾는다 → 있으면 그 목록을 지시로 붙여 **quality 를 한 단계 올려** 다시 그린다 →
 * 또 대조 … 차이가 없어지거나 끝 quality 까지 그릴 때까지(사용자 — "low 로 시작해서 퀄리티를
 * 하나씩 올리게끔"). 마지막에 **남은 차이가 가장 적은 그림**(같으면 더 싼 앞의 것)을 남긴다.
 *
 * **원문자(㉠ ① ⓐ)는 sol 이 지킨다**(사용자 — "원문자 주의를 선버스트에게 보내던 걸 sol 에게").
 * 이 화면의 sunburst 프롬프트에서는 원문자 지시(`CIRCLED_CHARS`)를 뺀다(`skipCircled`) — 운영
 * 프롬프트는 그대로다. 대신 sol 대조가 원문자를 안쪽 글자로 하나씩 세어 견주고, 틀린 원문자가
 * 있으면 다시 그릴 때 지시에 안쪽 글자 표가 붙는다(`accumulatedCorrection`).
 *
 * 조절하는 것: 시작·끝 quality, sol 의 추론 강도. sol 모델(`gpt-6.1-sol`)과 출력 크기(운영과 같은
 * 비율 맞춤)는 고정이다.
 *
 * 시간은 화면에서 잰 벽시계 시간(네트워크 포함), 원가는 공표 단가로 계산한 값이다.
 * 토큰은 차감하지 않는다. (운영·① 단독·③ 조판과 견주던 예전 비교 화면은 git 이력에 있다.)
 */

const SOL_MODEL = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high"];
/**
 * sunburst 출력 품질 사다리 — **low → medium → max 세 단계로 고정**이다(사용자 — "low min max
 * 3단계로 고정해서 고정배포하자"; `min` 은 `medium` 으로 읽었다). 한 번 그릴 때마다 한 칸
 * 올리고, 차이가 0곳이면 끝까지 안 가고 멈춘다. 그리기는 많아야 3번이다.
 */
const LADDER = ["low", "medium", "max"];

type Step = {
  label: string;
  state: "running" | "done" | "error";
  ms?: number;
  krw?: number | null;
  note?: string;
};

type Round = { img: string; quality: string; diffs?: TextDiff[] };

type Result = {
  rounds: Round[];
  /** 최종으로 남긴 그림의 번호(rounds 의 인덱스). */
  pick: number;
  ms: number;
  krw: number;
  unknownCost: boolean;
  quality: string;
  effort: string;
};

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

type GenResponse = { image: string; usage: { estKrw: number } | null };
type VerifyResponse = { diffs: TextDiff[]; estKrw: number | null };

const won = (krw: number | null | undefined) => (krw == null ? "?" : `${Math.round(krw).toLocaleString()}원`);
const secs = (ms: number | undefined) => (ms == null ? "…" : `${(ms / 1000).toFixed(1)}초`);

export default function CompareProblemPage() {
  const [name, setName] = useState("");
  const [prepared, setPrepared] = useState<string | null>(null);
  // 글자·도형을 세부까지 보게 하려고 기본을 high 로 둔다(사용자 — "sol 이 세부적으로 검토").
  const [effort, setEffort] = useState("high");
  const [steps, setSteps] = useState<Step[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<{ name: string; r: Result }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(f: File | null) {
    setPrepared(null);
    setError(null);
    setSteps([]);
    setRounds([]);
    setResult(null);
    if (!f) return;
    setName(f.name);
    try {
      // 운영 "AI로 다시 그리기"와 같은 입력 — 대비를 올리고 폭 1536 기준으로 줄인다.
      setPrepared(await prepareProblemForModel(await fileToDataUrl(f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
    }
  }

  async function run() {
    if (!prepared || busy) return;
    setBusy(true);
    setError(null);
    setSteps([]);
    setRounds([]);
    setResult(null);

    const local: Step[] = [];
    const flush = () => setSteps([...local]);
    /** 한 단계를 돌리며 시간·원가를 잰다. */
    async function step<T>(
      label: string,
      fn: () => Promise<{ value: T; krw: number | null; note?: string }>,
    ): Promise<T> {
      const s: Step = { label, state: "running" };
      local.push(s);
      flush();
      const t0 = performance.now();
      try {
        const { value, krw, note } = await fn();
        Object.assign(s, { state: "done", ms: performance.now() - t0, krw, note });
        return value;
      } catch (err) {
        Object.assign(s, { state: "error", ms: performance.now() - t0, note: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        flush();
      }
    }

    const original = prepared;
    const ladder = LADDER;
    const done: Round[] = [];
    const t0 = performance.now();
    try {
      const size = await imageSizeOf(original);
      let instruction: string | undefined;
      // 앞선 모든 시도의 실수를 모은다 — 그림은 버리고(입력은 늘 원본) 실수만 주의사항으로 넘긴다.
      const history: RoundDiffs[] = [];

      for (let i = 0; i < ladder.length; i++) {
        const n = i + 1;
        const q = ladder[i];
        const img = await step(
          n === 1 ? `그리기 1 (sunburst · quality=${q})` : `그리기 ${n} (quality=${q} · 틀린 곳을 지시로 붙여)`,
          async () => {
            const out = await postJson<GenResponse>({
              task: "generate",
              image: original,
              mode: "problem",
              instruction,
              quality: q,
              // 원문자는 sol 이 지킨다 — 이 화면의 sunburst 프롬프트에서는 원문자 지시를 뺀다.
              skipCircled: true,
              width: size?.width,
              height: size?.height,
            });
            return { value: out.image, krw: out.usage?.estKrw ?? null };
          },
        );
        const round: Round = { img, quality: q };
        done.push(round);
        setRounds([...done]);

        const diffs = await step(`대조 ${n} (${SOL_MODEL} ${effort})`, async () => {
          const { jobId } = await postJson<{ jobId: string }>({
            task: "verify",
            original,
            recreated: await toJpeg(img),
            model: SOL_MODEL,
            effort,
          });
          const out = await waitJob<VerifyResponse>(jobId);
          return { value: out.diffs, krw: out.estKrw, note: `차이 ${out.diffs.length}곳` };
        });
        round.diffs = diffs;
        setRounds([...done]);

        if (diffs.length === 0) break;
        history.push({ quality: q, diffs });
        instruction = accumulatedCorrection(history);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }

    // 끝까지 대조가 된 그림 중 차이가 가장 적은 것. 같으면 앞의 것(quality 가 낮아 더 싸다).
    let best = -1;
    done.forEach((r, i) => {
      if (r.diffs && (best === -1 || r.diffs.length < done[best].diffs!.length)) best = i;
    });
    if (best !== -1) {
      const r: Result = {
        rounds: done,
        pick: best,
        ms: performance.now() - t0,
        krw: local.reduce((a, s) => a + (s.krw ?? 0), 0),
        unknownCost: local.some((s) => s.state === "done" && s.krw == null),
        quality: ladder.join(" → "),
        effort,
      };
      setResult(r);
      setHistory((h) => [...h, { name: name || `문제 ${h.length + 1}`, r }]);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">sol 이 읽고 sunburst 가 고쳐 그리기</h1>
        <p className="mt-1 text-sm text-slate-600">
          sunburst 가 low 로 그리면 sol 이 원본과 대조해 글자가 다른 곳 · 깨진 글자 · 도형(모양·개수·위치·
          표시)이 다른 곳을 세부까지 찾고, 있으면 그 목록을 붙여 quality 를 한 단계(low → medium → max)
          올려 다시 그립니다. 차이가 없어지거나 max 까지 그리면 멈추고, 남은 차이가 가장 적은 그림을
          남깁니다. 원문자(㉠ ① ⓐ)는 sunburst 에게 따로 알려 주지 않고 sol 이 대조로
          지킵니다. 토큰은 차감하지 않습니다(무제한 계정 전용).
        </p>
      </div>

      <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          문제 사진 (문제 하나만 잘라 둔 것)
          <input type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="text-sm" />
        </label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5">
            sol 추론 강도
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className="rounded border px-2 py-1 text-xs">
              {EFFORTS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-slate-500">
          그리는 차례(고정): {LADDER.join(" → ")}
        </p>
        <div>
          <Button variant="primary" disabled={!prepared || busy} onClick={run}>
            {busy ? "돌리는 중…" : "돌리기"}
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

      {steps.length > 0 && (
        <section className={cn(cardClass, "flex flex-col gap-2 p-4")}>
          <Steps steps={steps} />
        </section>
      )}

      {result && (
        <section className={cn(cardClass, "flex flex-wrap items-baseline gap-x-6 gap-y-1 p-4 text-sm")}>
          <span className="font-semibold text-ink">
            최종: 그리기 {result.pick + 1}(quality={result.rounds[result.pick].quality}) · 남은 차이{" "}
            <span className={result.rounds[result.pick].diffs!.length ? "text-red-700" : "text-emerald-700"}>
              {result.rounds[result.pick].diffs!.length}곳
            </span>
          </span>
          <span className="tabular-nums text-slate-600">
            {result.rounds.length}번 그림 · 전체 {secs(result.ms)} · 원가 {won(result.krw)}
            {result.unknownCost ? "+?" : ""}
          </span>
        </section>
      )}

      {rounds.map((r, i) => (
        <section key={i} className={cn(cardClass, "flex flex-col gap-2 p-4")}>
          <p className="text-xs font-medium text-slate-600">
            그리기 {i + 1} · quality={r.quality}
            {result && result.pick === i ? " · 최종" : ""}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={r.img} alt={`그리기 ${i + 1}`} className="w-full rounded border bg-white" />
          {r.diffs ? <DiffList diffs={r.diffs} /> : <p className="text-xs text-slate-400">대조 중…</p>}
        </section>
      ))}

      {history.length > 0 && (
        <section className={cn(cardClass, "overflow-x-auto p-4")}>
          <h2 className="mb-2 font-semibold text-ink">이번 세션 기록</h2>
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1">문제</th>
                <th>quality 차례 · sol 강도</th>
                <th>그림 수</th>
                <th>시간</th>
                <th>원가</th>
                <th>남은 차이</th>
              </tr>
            </thead>
            <tbody>
              {history.map(({ name: n, r }, i) => {
                const d = r.rounds[r.pick].diffs!.length;
                return (
                  <tr key={i} className="border-t">
                    <td className="max-w-[160px] truncate py-1.5">{n}</td>
                    <td className="font-mono text-xs">
                      {r.quality} · {r.effort}
                    </td>
                    <td className="tabular-nums">{r.rounds.length}</td>
                    <td className="tabular-nums">{secs(r.ms)}</td>
                    <td className="tabular-nums">
                      {won(r.krw)}
                      {r.unknownCost ? "+?" : ""}
                    </td>
                    <td className={cn("tabular-nums font-semibold", d ? "text-red-700" : "text-emerald-700")}>{d}곳</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">새로고침하면 사라져요. 원가는 공표 단가로 계산한 값이에요.</p>
        </section>
      )}
    </main>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {steps.map((s, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2">
          <span className={s.state === "error" ? "text-red-600" : s.state === "running" ? "text-blue-700" : "text-slate-700"}>
            {s.state === "running" ? "⏳" : s.state === "error" ? "✕" : "✓"} {s.label}
          </span>
          <span className="tabular-nums text-slate-500">
            {secs(s.ms)} · {won(s.krw)}
          </span>
          {s.note && <span className="text-xs text-slate-500">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function DiffList({ diffs }: { diffs: TextDiff[] }) {
  if (diffs.length === 0) return <p className="text-xs font-medium text-emerald-700">대조: 글자·도형 차이 없음</p>;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/60 p-2 text-xs">
      <p className="mb-1 font-semibold text-red-700">
        대조: 차이 {diffs.length}곳
        <span className="ml-1 font-normal text-slate-600">
          (글자 {diffs.filter((d) => (d.kind ?? "text") === "text").length} · 깨진 글자{" "}
          {diffs.filter((d) => d.kind === "glyph").length} · 도형 {diffs.filter((d) => d.kind === "figure").length} · 손글씨{" "}
          {diffs.filter((d) => d.kind === "handwriting").length})
        </span>
      </p>
      <ul className="flex flex-col gap-0.5">
        {diffs.map((d, i) => (
          <li key={i}>
            <span className="mr-1 rounded bg-white px-1 text-[10px] font-semibold text-red-700 ring-1 ring-red-200">
              {d.kind === "glyph" ? "깨진 글자" : d.kind === "figure" ? "도형" : d.kind === "handwriting" ? "손글씨" : "글자"}
            </span>
            {d.where && <span className="text-slate-500">[{d.where}] </span>}
            원본 <b>{d.original || "∅"}</b> → <span className="text-red-700">{d.recreated || "(빠짐)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
