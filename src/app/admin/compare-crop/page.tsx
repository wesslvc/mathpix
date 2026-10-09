"use client";

import { useEffect, useState } from "react";
import { cropImageToDataUrl, loadDrawableFromFile, loadImage, NO_CROP_LIMIT, openPageSource, type PageSource } from "@/lib/cropImage";
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
  { key: "orQ32", engine: "openrouter", model: "qwen/qwen3-vl-32b-instruct" }, // $0.104/$0.416
  { key: "orQ30", engine: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct" }, // $0.15/$0.60
  { key: "orQ38", engine: "openrouter", model: "qwen/qwen3.8-flash" }, // $0.15/$0.47
  { key: "orSeed", engine: "openrouter", model: "bytedance-seed/seed-1.6-flash" }, // $0.075/$0.30
  { key: "orLing", engine: "openrouter", model: "inclusionai/ling-3.0-flash-vl" }, // $0.021/$0.062
  { key: "orG26", engine: "openrouter", model: "google/gemma-4-26b-a4b-it" }, // $0.09/$0.30
  { key: "orScout", engine: "openrouter", model: "meta-llama/llama-4-scout" }, // $0.10/$0.30
  { key: "or31l", engine: "openrouter", model: "google/gemini-3.1-flash-lite" }, // $0.25/$1.50
  { key: "orHaiku", engine: "openrouter", model: "anthropic/claude-haiku-5.5" }, // $0.10/$0.50 — 지금까지 1위 (운영 확정)
  { key: "orHaikuL", engine: "openrouter", model: "anthropic/claude-haiku-5.5", effort: "low" },
  { key: "orHaikuM", engine: "openrouter", model: "anthropic/claude-haiku-5.5", effort: "medium" },
  { key: "orHaikuH", engine: "openrouter", model: "anthropic/claude-haiku-5.5", effort: "high" },
  { key: "orQ36", engine: "openrouter", model: "qwen/qwen3.6-35b-a3b" }, // $0.15/$1.00 — RefCOCO 상위 Qwen3.6 계열 중 가장 쌈
  { key: "orGlmF", engine: "openrouter", model: "z-ai/glm-5.3-flash" }, // $0.15/$0.50 — 오픈라우터 비전 사용량 상위
  { key: "orMimo", engine: "openrouter", model: "xiaomi/mimo-v2.6-flash" }, // $0.14/$0.28
  { key: "orDsV", engine: "openrouter", model: "deepseek/deepseek-v4-flash-vision-exp" }, // $0.216/$0.647
  { key: "orGlm", engine: "openrouter", model: "z-ai/glm-5v-turbo" }, // $1.20/$4.00 — GLM 비전(V) 계열 중 가장 새것
];
const DEFAULT_ON = new Set(["orHaiku", "orHaikuM", "orHaikuH", "g35l"]);
const PAD = 0.008;
const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777"];

const nameOf = (c: Cand) => (c.effort ? `${c.model} (${c.effort})` : c.model);

type Res = {
  state: "running" | "refining" | "done" | "error";
  ms?: number;
  refineMs?: number;
  refined?: number;
  refineKrw?: number;
  error?: string;
  raw?: DetectedProblem[];
  final?: DetectedProblem[];
  pieces?: { crop: string; parts: number; no?: string }[];
  usage?: { input: number; cached: number; output: number } | null;
  estKrw?: number | null;
};

/**
 * `image` = 모델에 보내는 줄인 그림(영역 찾기 전용), `file`·`view` = **고해상도 원본**(2026-10-09, 사용자 — "고해상도 원본을 보여 주고 여기서
 * 바로 크롭하는 구조로"). 화면에 보이는 것도, 확대해 다시 맞추는 창도, 잘리는 조각도 전부 이 원본에서 나온다 — 운영 지면 자르기와 같다.
 */
type Page = { id: string; name: string; image: string; w: number; h: number; file: File; view: string };

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
  return { id: crypto.randomUUID(), name: file.name, image, w: img.naturalWidth, h: img.naturalHeight, file, view: URL.createObjectURL(file) };
}

export default function ComparePageCropPage() {
  const [pages, setPages] = useState<Page[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set(DEFAULT_ON));
  const [custom, setCustom] = useState<Cand[]>([]);
  const [customText, setCustomText] = useState("");
  const [orList, setOrList] = useState<{ id: string; free: boolean; p: number; c: number }[] | null>(null);
  const [orBusy, setOrBusy] = useState(false);
  const [orQuery, setOrQuery] = useState("");
  const [orFreeOnly, setOrFreeOnly] = useState(false);
  const [refine, setRefine] = useState(true);
  const [refineEffort, setRefineEffort] = useState<"low" | "medium" | "high">("medium");
  const [results, setResults] = useState<Record<string, Res>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [ran, setRan] = useState<Cand[]>([]);

  // 결과를 보고 "패스"(남김 표시) / "실패"(목록에서 지움)를 고른다. 지운 것은 기기에 기억해 다음에도 안 나온다.
  const [marks, setMarks] = useState<Record<string, "pass">>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem("reprint.cropRemoved");
      if (raw) setRemoved(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* 저장소가 막혀 있어도 화면은 그대로 */
    }
  }, []);
  function saveRemoved(n: Set<string>) {
    setRemoved(n);
    try {
      localStorage.setItem("reprint.cropRemoved", JSON.stringify([...n]));
    } catch {
      /* 무시 */
    }
  }
  function markPass(key: string) {
    setMarks((m) => {
      const n = { ...m };
      if (n[key]) delete n[key];
      else n[key] = "pass";
      return n;
    });
  }
  function markFail(key: string) {
    saveRemoved(new Set(removed).add(key));
    setOn((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    setMarks((m) => {
      const n = { ...m };
      delete n[key];
      return n;
    });
  }

  const orWords = orQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const orShown = (orList ?? []).filter((m) => (!orFreeOnly || m.free) && orWords.every((w) => m.id.toLowerCase().includes(w)));
  const cands = [...PRESETS, ...custom].filter((c) => !removed.has(c.key));
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
    const out: string[] = [`# 지면 자르기 비교 ${new Date().toLocaleString("ko-KR")}`, `다시 맞추기: ${refine ? `켬(${refineEffort})` : "끔"}`, ""];
    for (const p of pages) {
      out.push(`## 지면: ${p.name} (${p.w}×${p.h})`);
      for (const c of ran.filter((x) => !removed.has(x.key))) {
        const r = results[`${p.id}|${c.key}`];
        if (!r) continue;
        const head = `### ${nameOf(c)} [${c.engine}]${marks[c.key] ? " ✅패스" : ""}`;
        if (r.state === "error") {
          out.push(head, `- 실패: ${r.error ?? "?"}`, "");
          continue;
        }
        out.push(
          head,
          `- 상태: ${r.state} · 찾기 ${r.ms != null ? (r.ms / 1000).toFixed(1) : "?"}s${r.refineMs != null ? ` · 다시 맞추기 ${(r.refineMs / 1000).toFixed(1)}s(${r.refined ?? 0}곳${r.refineKrw ? `, ${r.refineKrw.toFixed(2)}원` : ""})` : ""}`,
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
    setCustom((c) => [...c, { key, engine, model, ...(effort && engine !== "gemini" ? { effort } : {}) }]);
    setOn((s) => new Set(s).add(key));
    setCustomText("");
  }

  async function runOne(p: Page, c: Cand, withRefine: boolean, srcP: Promise<PageSource>) {
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
      const src = await srcP; // 원본(고해상도) — 지면마다 한 번만 열어 모델끼리 나눠 쓴다(64MP 를 모델 수만큼 열면 탭이 죽는다)
      const img = src.img;
      let found = raw;
      let refineMs: number | undefined;
      let refined: number | undefined;
      let refineKrw: number | undefined;
      if (withRefine && raw.length) {
        set({ state: "refining", ms, raw, usage: j.usage, estKrw: j.estKrw });
        const t1 = performance.now();
        const r = await refineProblems(raw, cutRefineWindows(img, src.width, src.height, raw), `비교 ${nameOf(c)}`, refineEffort);
        refineMs = Math.round(performance.now() - t1);
        refined = r.refined;
        refineKrw = r.krw;
        found = r.problems;
      }
      const final = snapPageProblems(img, src.width, src.height, found).problems;
      const pieces = await Promise.all(
        final.map(async (pr) => ({
          crop: await stitchVertically(pr.boxes.map((b) => cropRegionToDataUrl(img, b, PAD, NO_CROP_LIMIT))),
          parts: pr.boxes.length,
          no: pr.no,
        })),
      );
      set({ state: "done", ms, refineMs, refined, refineKrw, raw, final, pieces, usage: j.usage, estKrw: j.estKrw });
    } catch (err) {
      set({ state: "error", ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function runAll() {
    if (!pages.length || !chosen.length) return;
    setRan(chosen);
    setResults({});
    // 지면마다 원본을 한 번만 연다(열기 자체는 한 장씩 잇는다 — 메모리).
    const sources = new Map<string, Promise<PageSource>>();
    let chain: Promise<unknown> = Promise.resolve();
    for (const p of pages) {
      const open = chain.then(() => openPageSource(p.file, p.image));
      sources.set(p.id, open);
      chain = open.catch(() => undefined);
    }
    try {
      await Promise.all(pages.flatMap((p) => chosen.map((c) => runOne(p, c, refine, sources.get(p.id)!))));
    } finally {
      for (const pr of sources.values()) void pr.then((s) => s.revoke()).catch(() => undefined);
    }
  }

  const summary = ran.filter((c) => !removed.has(c.key)).map((c) => {
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
      refineKrw: done.reduce((a, r) => a + (r.refineKrw ?? 0), 0),
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
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={orQuery}
                onChange={(e) => setOrQuery(e.target.value)}
                placeholder="모델 검색: qwen, glm, flash …(공백으로 여러 단어)"
                className="min-w-0 flex-1"
              />
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
                <input type="checkbox" checked={orFreeOnly} onChange={(e) => setOrFreeOnly(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
                무료만
              </label>
              <span className="text-xs text-slate-400">
                {orShown.length}/{orList.length}개
              </span>
            </div>
          )}
          {orList && (
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {orShown.length === 0 && <span className="text-xs text-slate-400">맞는 모델이 없어요.</span>}
              {orShown.map((m) => (
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
          문제마다 확대해 다시 맞추기(luna, 문제 하나당 한 번씩 — 시간·비용이 가장 많이 드는 단계)
        </label>
        {refine && (
          <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-slate-600">
            추론 강도
            {(["low", "medium", "high"] as const).map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setRefineEffort(e)}
                className={cn("rounded-full border px-2.5 py-0.5", refineEffort === e ? "border-blue-500 bg-blue-500 text-white" : "border-slate-300 hover:bg-slate-50")}
              >
                {e}
              </button>
            ))}
            <span className="text-slate-400">운영 기본은 medium. 낮출수록 빠르고 싸요 — 결과 카드·요약 표의 "다시 맞추기 원가·시간"으로 견주세요.</span>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button type="button" variant="primary" disabled={!pages.length || !chosen.length || busy !== null} onClick={() => void runAll()}>
            {pages.length}장 × {chosen.length}개 모델 자르기
          </Button>
          {busy && <span className="text-xs text-slate-500">{busy}</span>}
          {removed.size > 0 && (
            <button type="button" className="text-xs text-slate-500 underline" onClick={() => saveRemoved(new Set())}>
              지운 모델 {removed.size}개 되살리기
            </button>
          )}
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
                <th>다시 맞추기 원가</th>
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
                  <td>{s.refineKrw > 0 ? `${s.refineKrw.toFixed(1)}원` : "–"}</td>
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
            {(ran.length ? ran : chosen).filter((c) => !removed.has(c.key)).map((c) => {
              const r = results[`${p.id}|${c.key}`];
              return (
                <div key={c.key} className={cn(cardClass, "flex w-80 shrink-0 flex-col gap-2 p-2")}>
                  <div className="flex items-center justify-between gap-1">
                    <div className="min-w-0 truncate text-xs font-semibold text-slate-700" title={nameOf(c)}>
                      {nameOf(c)}
                    </div>
                    {r && (r.state === "done" || r.state === "error") && (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => markPass(c.key)}
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                            marks[c.key] ? "border-emerald-500 bg-emerald-500 text-white" : "border-emerald-300 text-emerald-700 hover:bg-emerald-50",
                          )}
                        >
                          패스
                        </button>
                        <button
                          type="button"
                          onClick={() => markFail(c.key)}
                          title="이 모델을 목록에서 지워요(다음에도 안 나와요)"
                          className="rounded-full border border-red-300 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
                        >
                          실패
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="relative w-full bg-slate-100" style={{ aspectRatio: `${p.w} / ${p.h}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.view} alt="" className="absolute inset-0 h-full w-full" onError={(e) => { const t = e.currentTarget; if (t.src !== p.image) t.src = p.image; }} />
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
                          {r.refineMs != null && ` · 다시 맞추기 ${(r.refineMs / 1000).toFixed(1)}초(${r.refined}곳${r.refineKrw ? `, ${r.refineKrw.toFixed(1)}원` : ""})`}
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
