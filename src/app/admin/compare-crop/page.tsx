"use client";

import { useState } from "react";
import { cropImageToDataUrl, loadDrawableFromFile, loadImage } from "@/lib/cropImage";
import { enhanceContrast } from "@/lib/autoContrast";
import { DETECT_INPUT_DIM, MAX_UPLOAD_CHARS, stitchVertically } from "@/lib/figureImage";
import { cropRegionToDataUrl } from "@/lib/polygon";
import { cutRefineWindows, refineProblems, snapPageProblems } from "@/lib/pageRefine";
import type { DetectedProblem } from "@/lib/detectProblems";
import type { ProblemBox } from "@/lib/problemBoxes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * **지면 자르기 비교**(2026-10-09, 사용자 — "자동 자르기 비교 화면 만들어 줘"·"테스트하는 걸 지면 자르기로 테스트하자"). 무제한 계정 전용,
 * 토큰 안 뗌.
 *
 * 지면 사진을 여러 장 올리고 견줄 모델을 고르면 사진 × 모델마다 운영과 **같은** 지면 영역 찾기(같은 프롬프트·같은 그림 — 긴 변 3000 부터
 * 본문 한도에 맞춰 줄이고 대비 올리기 · 단을 넘어 이어진 문제를 묶는 규칙까지)를 동시에 부른다. 그 뒤 화면이 운영과 같은 함수로
 * ① (켜면) 문제마다 확대해 luna 로 다시 맞추고(`refineProblems`) ② 글자에 맞춰 다듬어(`snapPageProblems`) 잘린 조각을 보여 준다.
 *
 * 카드마다: 지면 위 점선 = 모델이 준 자리, 실선 = 실제로 잘리는 자리(문제마다 색), 그 아래 잘린 조각들(단을 넘어 합친 것은 "N조각 합침").
 * 맨 위 표: 모델마다 평균 찾기 시간·다시 맞추기 시간·찾은 문제 수·합친 문제 수·실패·원가.
 */

type Cand = { key: string; engine: "gemini" | "openai" | "openrouter"; model: string; effort?: string };

const LUNA = "gpt-6-luna";
const PRESETS: Cand[] = [
  { key: "g35l", engine: "gemini", model: "gemini-3.5-flash-lite" },
  { key: "gfll", engine: "gemini", model: "gemini-flash-lite-latest" },
  { key: "g38", engine: "gemini", model: "gemini-3.8-flash" },
  { key: "gfl", engine: "gemini", model: "gemini-flash-latest" },
  { key: "lunaL", engine: "openai", model: LUNA, effort: "low" },
  { key: "lunaM", engine: "openai", model: LUNA, effort: "medium" },
  { key: "lunaH", engine: "openai", model: LUNA, effort: "high" },
  // OpenRouter — 이름·단가는 비교 화면의 "오픈라우터 이미지 모델 불러오기" 목록에서 그대로 옮겼다(2026-10-09, $ 입력/출력 100만 토큰당).
  { key: "or25l", engine: "openrouter", model: "google/gemini-2.5-flash-lite" }, // $0.10/$0.40
  { key: "or31l", engine: "openrouter", model: "google/gemini-3.1-flash-lite" }, // $0.25/$1.50
  { key: "orQ32", engine: "openrouter", model: "qwen/qwen3-vl-32b-instruct" }, // $0.10/$0.42
  { key: "orQ38", engine: "openrouter", model: "qwen/qwen3.8-flash" }, // $0.15/$0.47
  { key: "orG31", engine: "openrouter", model: "google/gemma-4-31b-it" }, // $0.09/$0.34
  { key: "orGf", engine: "openrouter", model: "google/gemma-4-31b-it:free" },
];
const DEFAULT_ON = new Set(["gfll", "lunaM", "or25l", "orQ32"]);
const PAD = 0.008;
const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777"];

const nameOf = (c: Cand) => (c.effort ? `${c.model} (${c.effort})` : c.model);

type Res = {
  state: "running" | "refining" | "done" | "error";
  ms?: number;
  refineMs?: number;
  refined?: number;
  error?: string;
  raw?: DetectedProblem[];
  final?: DetectedProblem[];
  pieces?: { crop: string; parts: number; no?: string }[];
  usage?: { input: number; cached: number; output: number } | null;
  estKrw?: number | null;
};

type Page = { id: string; name: string; image: string; w: number; h: number };

/** 운영 지면 영역 찾기와 같은 그림(`BatchSplitPanel.detectImage`). */
async function prepare(file: File): Promise<Page> {
  const d = await loadDrawableFromFile(file);
  let last = "";
  try {
    const whole = { x: 0, y: 0, width: d.width, height: d.height };
    for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
      last = cropImageToDataUrl(d.src, whole, { maxWidth: dim, maxHeight: dim });
      if (last.length <= MAX_UPLOAD_CHARS) break;
    }
  } finally {
    d.close();
  }
  const enhanced = await enhanceContrast(last);
  const image = enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : last;
  const img = await loadImage(image);
  return { id: crypto.randomUUID(), name: file.name, image, w: img.naturalWidth, h: img.naturalHeight };
}

export default function ComparePageCropPage() {
  const [pages, setPages] = useState<Page[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set(DEFAULT_ON));
  const [custom, setCustom] = useState<Cand[]>([]);
  const [customText, setCustomText] = useState("");
  const [orList, setOrList] = useState<{ id: string; free: boolean; p: number; c: number }[] | null>(null);
  const [orBusy, setOrBusy] = useState(false);
  const [refine, setRefine] = useState(true);
  const [results, setResults] = useState<Record<string, Res>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [ran, setRan] = useState<Cand[]>([]);

  const cands = [...PRESETS, ...custom];
  const chosen = cands.filter((c) => on.has(c.key));

  async function pick(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy("지면을 준비하는 중…");
    const out: Page[] = [];
    for (const f of list) {
      try {
        out.push(await prepare(f));
      } catch (err) {
        alert(`${f.name}: ${err instanceof Error ? err.message : "열지 못함"}`);
      }
    }
    setPages((p) => [...p, ...out]);
    setBusy(null);
  }

  async function loadOpenRouter() {
    setOrBusy(true);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      const j = (await res.json()) as {
        data?: { id?: string; architecture?: { input_modalities?: string[] }; pricing?: { prompt?: string; completion?: string } }[];
      };
      const list = (j.data ?? [])
        .filter((m) => m.id && m.architecture?.input_modalities?.includes("image"))
        .map((m) => {
          const p = Number(m.pricing?.prompt ?? 0) * 1e6;
          const c = Number(m.pricing?.completion ?? 0) * 1e6;
          return { id: m.id as string, free: (m.id as string).endsWith(":free") || (p === 0 && c === 0), p, c };
        })
        .sort((a, b) => Number(b.free) - Number(a.free) || a.p + a.c - (b.p + b.c) || a.id.localeCompare(b.id));
      setOrList(list);
    } catch (err) {
      alert(`목록을 못 불러왔어요: ${err instanceof Error ? err.message : err}`);
    } finally {
      setOrBusy(false);
    }
  }

  function addOr(id: string) {
    const key = `or:${id}`;
    setCustom((c) => (c.some((x) => x.key === key) ? c : [...c, { key, engine: "openrouter", model: id }]));
    setOn((s) => new Set(s).add(key));
  }

  /** 결과 전부(모델·지면별 상태·시간·오류·토큰·원가·찾은 박스)를 글 한 덩어리로 — 복사하거나 파일로 받는다. */
  function buildReport(): string {
    const f1 = (n: number) => (Math.round(n * 1000) / 10).toFixed(1);
    const out: string[] = [`# 지면 자르기 비교 ${new Date().toLocaleString("ko-KR")}`, `다시 맞추기: ${refine ? "켬" : "끔"}`, ""];
    for (const p of pages) {
      out.push(`## 지면: ${p.name} (${p.w}×${p.h})`);
      for (const c of chosen) {
        const r = results[`${p.id}|${c.key}`];
        if (!r) continue;
        const head = `### ${nameOf(c)} [${c.engine}]`;
        if (r.state === "error") {
          out.push(head, `- 실패: ${r.error ?? "?"}`, "");
          continue;
        }
        out.push(
          head,
          `- 상태: ${r.state} · 찾기 ${r.ms != null ? (r.ms / 1000).toFixed(1) : "?"}s${r.refineMs != null ? ` · 다시 맞추기 ${(r.refineMs / 1000).toFixed(1)}s(${r.refined ?? 0}곳)` : ""}`,
          `- 토큰: 입력 ${r.usage?.input ?? "?"} · 출력 ${r.usage?.output ?? "?"} · 원가 ${r.estKrw != null ? `${r.estKrw.toFixed(2)}원` : "단가 모름"}`,
          `- 찾은 문제 ${r.raw?.length ?? 0}개 (모델 자리, 지면 대비 % — x,y,w,h):`,
        );
        for (const q of r.raw ?? []) {
          out.push(`  - ${q.no ?? "번호?"}번: ${q.boxes.map((b) => `[${f1(b.x)},${f1(b.y)},${f1(b.w)},${f1(b.h)}]`).join(" + ")}`);
        }
        out.push("");
      }
    }
    return out.join("\n");
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(buildReport());
      alert("결과를 복사했어요.");
    } catch {
      alert("복사하지 못했어요 — '파일로 받기'를 쓰세요.");
    }
  }

  function downloadReport() {
    const url = URL.createObjectURL(new Blob([buildReport()], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `crop-compare-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function addCustom() {
    const t = customText.trim();
    if (!t) return;
    const [model, effort] = t.split(/\s+/);
    const engine: Cand["engine"] = model.startsWith("gemini") ? "gemini" : model.includes("/") ? "openrouter" : "openai";
    const key = `c${Date.now()}`;
    setCustom((c) => [...c, { key, engine, model, ...(effort && engine === "openai" ? { effort } : {}) }]);
    setOn((s) => new Set(s).add(key));
    setCustomText("");
  }

  async function runOne(p: Page, c: Cand, withRefine: boolean) {
    const k = `${p.id}|${c.key}`;
    const set = (r: Res) => setResults((all) => ({ ...all, [k]: r }));
    set({ state: "running" });
    const t0 = performance.now();
    try {
      const res = await fetch("/api/admin/compare-crop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: p.image, engine: c.engine, model: c.model, effort: c.effort }),
      });
      const j = await res.json();
      const ms = Math.round(performance.now() - t0);
      if (!res.ok || !j.ok) {
        set({ state: "error", ms, error: j.error ?? `HTTP ${res.status}` });
        return;
      }
      const raw = (j.problems ?? []) as DetectedProblem[];
      const img = await loadImage(p.image);
      let found = raw;
      let refineMs: number | undefined;
      let refined: number | undefined;
      if (withRefine && raw.length) {
        set({ state: "refining", ms, raw, usage: j.usage, estKrw: j.estKrw });
        const t1 = performance.now();
        const r = await refineProblems(raw, cutRefineWindows(img, img.naturalWidth, img.naturalHeight, raw), `비교 ${nameOf(c)}`);
        refineMs = Math.round(performance.now() - t1);
        refined = r.refined;
        found = r.problems;
      }
      const final = snapPageProblems(img, img.naturalWidth, img.naturalHeight, found).problems;
      const pieces = await Promise.all(
        final.map(async (pr) => ({
          crop: await stitchVertically(pr.boxes.map((b) => cropRegionToDataUrl(img, b, PAD))),
          parts: pr.boxes.length,
          no: pr.no,
        })),
      );
      set({ state: "done", ms, refineMs, refined, raw, final, pieces, usage: j.usage, estKrw: j.estKrw });
    } catch (err) {
      set({ state: "error", ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function runAll() {
    if (!pages.length || !chosen.length) return;
    setRan(chosen);
    setResults({});
    await Promise.all(pages.flatMap((p) => chosen.map((c) => runOne(p, c, refine))));
  }

  const summary = ran.map((c) => {
    const rs = pages.map((p) => results[`${p.id}|${c.key}`]).filter((r): r is Res => !!r && (r.state === "done" || r.state === "error"));
    const done = rs.filter((r) => r.state === "done");
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      c,
      n: rs.length,
      errors: rs.length - done.length,
      ms: avg(rs.map((r) => r.ms ?? 0)),
      refineMs: avg(done.filter((r) => r.refineMs != null).map((r) => r.refineMs!)),
      problems: done.reduce((a, r) => a + (r.final?.length ?? 0), 0),
      merged: done.reduce((a, r) => a + (r.final?.filter((x) => x.boxes.length > 1).length ?? 0), 0),
      noNumber: done.reduce((a, r) => a + (r.final?.filter((x) => !x.no).length ?? 0), 0),
      refined: done.reduce((a, r) => a + (r.refined ?? 0), 0),
      krw: done.reduce((a, r) => a + (r.estKrw ?? 0), 0),
      krwKnown: done.some((r) => r.estKrw != null),
    };
  });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">지면 자르기 비교</h1>
        <p className="text-xs text-slate-500">
          운영 지면 영역 찾기와 같은 프롬프트·같은 그림으로 모델만 바꿔 찾습니다(단을 넘어 이어진 문제 묶기 포함). 그 뒤 운영과 같은 함수로
          다시 맞추고(켜면, luna) 글자에 맞춰 다듬어 자릅니다. 점선 = 모델이 준 자리, 실선 = 실제로 잘리는 자리. 토큰은 차감하지 않아요.
        </p>
      </div>

      <section className={cn(cardClass, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept="image/*" multiple onChange={(e) => void pick(e.target.files)} className="g-file min-w-0 flex-1" />
          {pages.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { setPages([]); setResults({}); }}>
              지면 비우기 ({pages.length}장)
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {cands.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={on.has(c.key)}
                onChange={() =>
                  setOn((s) => {
                    const n = new Set(s);
                    if (n.has(c.key)) n.delete(c.key);
                    else n.add(c.key);
                    return n;
                  })
                }
                className="h-4 w-4 accent-blue-600"
              />
              {nameOf(c)}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustom()}
            placeholder="다른 모델: gemini-3.6-flash · gpt-6-luna xhigh · 오픈라우터는 google/…:free 처럼 슬래시 이름"
            className="min-w-0 flex-1"
          />
          <Button type="button" variant="outline" size="sm" onClick={addCustom}>
            추가
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <div>
            <Button type="button" variant="outline" size="sm" disabled={orBusy} onClick={() => void loadOpenRouter()}>
              {orBusy ? "불러오는 중…" : "오픈라우터 이미지 모델 불러오기"}
            </Button>
            {orList && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-2"
                onClick={() => {
                  const t = orList.map((m) => `${m.id}\t${m.free ? "무료" : `$${m.p.toFixed(3)}/$${m.c.toFixed(3)}`}`).join("\n");
                  void navigator.clipboard.writeText(`모델\t입력/출력 $/100만토큰\n${t}`).then(() => alert(`${orList.length}개 모델 목록을 복사했어요.`));
                }}
              >
                목록 복사
              </Button>
            )}
          </div>
          {orList && (
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {orList.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => addOr(m.id)}
                  title={m.free ? "무료" : `입력 $${m.p.toFixed(3)} · 출력 $${m.c.toFixed(3)} / 100만 토큰 (칩 숫자 = 입력/출력)`}
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    m.free ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-600"
                  } hover:border-blue-400`}
                >
                  {m.id}
                  {!m.free && <span className="ml-1 text-slate-400">${m.p.toFixed(2)}/${m.c.toFixed(2)}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} className="h-4 w-4 accent-blue-600" />
          문제마다 확대해 다시 맞추기(운영과 같이 luna medium — 문제당 1원 안팎)
        </label>
        <div className="flex items-center gap-3">
          <Button type="button" variant="primary" disabled={!pages.length || !chosen.length || busy !== null} onClick={() => void runAll()}>
            {pages.length}장 × {chosen.length}개 모델 자르기
          </Button>
          {busy && <span className="text-xs text-slate-500">{busy}</span>}
          <Button type="button" variant="outline" size="sm" disabled={Object.keys(results).length === 0} onClick={() => void copyReport()}>
            결과 복사
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={Object.keys(results).length === 0} onClick={downloadReport}>
            파일로 받기
          </Button>
        </div>
      </section>

      {summary.length > 0 && (
        <section className={cn(cardClass, "overflow-x-auto p-4")}>
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1">모델</th>
                <th>찾기 평균</th>
                <th>다시 맞추기 평균</th>
                <th>문제 수</th>
                <th>단 넘어 합침</th>
                <th>번호 없음</th>
                <th>다시 맞춘 곳</th>
                <th>실패</th>
                <th>찾기 원가</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.c.key} className="border-t border-slate-100">
                  <td className="py-1.5 font-medium">{nameOf(s.c)}</td>
                  <td>{s.ms != null ? `${(s.ms / 1000).toFixed(1)}초` : "…"}</td>
                  <td>{s.refineMs != null ? `${(s.refineMs / 1000).toFixed(1)}초` : "–"}</td>
                  <td>{s.problems}</td>
                  <td>{s.merged}</td>
                  <td>{s.noNumber}</td>
                  <td>{s.refined}</td>
                  <td className={s.errors ? "text-red-600" : ""}>{s.errors}</td>
                  <td>{s.krwKnown ? `${s.krw.toFixed(1)}원` : "단가 모름"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {pages.map((p) => (
        <section key={p.id} className="flex flex-col gap-2">
          <h2 className="truncate text-sm font-medium text-slate-700">
            {p.name} <span className="text-xs text-slate-400">{p.w}×{p.h}</span>
          </h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
            {(ran.length ? ran : chosen).map((c) => {
              const r = results[`${p.id}|${c.key}`];
              return (
                <div key={c.key} className={cn(cardClass, "flex w-80 shrink-0 flex-col gap-2 p-2")}>
                  <div className="text-xs font-semibold text-slate-700">{nameOf(c)}</div>
                  <div className="relative w-full bg-slate-100" style={{ aspectRatio: `${p.w} / ${p.h}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.image} alt="" className="absolute inset-0 h-full w-full" />
                    {r?.raw?.map((pr, i) =>
                      pr.boxes.map((b, j) => (
                        <Rect key={`r${i}-${j}`} b={b} style={{ borderColor: COLORS[i % COLORS.length] }} className="border border-dashed opacity-70" />
                      )),
                    )}
                    {r?.final?.map((pr, i) =>
                      pr.boxes.map((b, j) => (
                        <Rect key={`f${i}-${j}`} b={b} style={{ borderColor: COLORS[i % COLORS.length] }} className="border-2">
                          {j === 0 && (
                            <span className="absolute left-0 top-0 rounded-br px-1 text-[9px] font-bold text-white" style={{ background: COLORS[i % COLORS.length] }}>
                              {pr.no || "?"}
                              {pr.boxes.length > 1 && `+${pr.boxes.length - 1}`}
                            </span>
                          )}
                        </Rect>
                      )),
                    )}
                    {(r?.state === "running" || r?.state === "refining") && (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-white/50 text-[11px] text-slate-600">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
                        {r.state === "running" ? "찾는 중" : "다시 맞추는 중"}
                      </span>
                    )}
                  </div>
                  {r && (r.state === "done" || r.state === "error") && (
                    <div className="text-[11px] leading-relaxed text-slate-600">
                      {r.state === "error" ? (
                        <span className="text-red-600">{r.error}</span>
                      ) : (
                        <>
                          찾기 <b>{((r.ms ?? 0) / 1000).toFixed(1)}초</b>
                          {r.refineMs != null && ` · 다시 맞추기 ${(r.refineMs / 1000).toFixed(1)}초(${r.refined}곳)`}
                          {` · 문제 ${r.final?.length ?? 0}개`}
                          {r.final?.some((x) => x.boxes.length > 1) && ` · 합침 ${r.final.filter((x) => x.boxes.length > 1).length}`}
                          <br />
                          {r.usage && `입력 ${r.usage.input} · 출력 ${r.usage.output}`}
                          {r.estKrw != null ? ` · ${r.estKrw.toFixed(2)}원` : " · 단가 모름"}
                        </>
                      )}
                    </div>
                  )}
                  {r?.pieces && (
                    <div className="flex max-h-[32rem] flex-col gap-1.5 overflow-y-auto">
                      {r.pieces.map((pc, i) => (
                        <div key={i} className="relative rounded border border-slate-200 bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={pc.crop} alt="" className="w-full" />
                          <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                            {pc.no ? `${pc.no}번` : "번호 ?"}
                            {pc.parts > 1 && ` · ${pc.parts}조각 합침`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}

function Rect({
  b,
  className,
  style,
  children,
}: {
  b: ProblemBox;
  className: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <span
      className={cn("pointer-events-none absolute", className)}
      style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, ...style }}
    >
      {children}
    </span>
  );
}
