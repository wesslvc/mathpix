"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { putBlob, removeBlobs } from "@/lib/blobClient";
import { cropImageToDataUrl, loadDrawableFromFile, loadImage, NO_CROP_LIMIT, openPageSource, type PageSource } from "@/lib/cropImage";
import { enhanceContrast } from "@/lib/autoContrast";
import { DETECT_INPUT_DIM, MAX_UPLOAD_CHARS, stitchVertically } from "@/lib/figureImage";
import { cropRegionToDataUrl } from "@/lib/polygon";
import { cutRefineWindows, refineProblems, snapPageProblems } from "@/lib/pageRefine";
import type { DetectedProblem } from "@/lib/detectProblems";
import type { ProblemBox } from "@/lib/problemBoxes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import BoxEditor, { type EditBox } from "@/components/BoxEditor";
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
// 하이쿠로 확정(2026-10-09) — 다른 후보는 전부 걷어냈다(git 이력에 있다). 다른 모델은 아래 "직접 적기"나 오픈라우터 목록으로 다시 추가할 수 있다.
const SOL = "gpt-6.1-sol"; // 서버 OPENAI_TEXT_MODEL 기본값과 같다(다르면 서버가 거절한다)
const PRESETS: Cand[] = [
  { key: "orHaiku", engine: "openrouter", model: "anthropic/claude-haiku-5.5" },
  { key: "solL", engine: "openai", model: SOL, effort: "low" },
];
const DEFAULT_ON = new Set(["orHaiku", "solL"]);
const PAD = 0.012;
const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777"];

/**
 * **손으로 맞춘 정답(상수)** — 파일 이름이 같은 지면을 올리면 자동으로 채워진다(사용자 — "손으로 짜른 걸 상수 취급해").
 * 지면 대비 비율(0~1) x,y,w,h, 읽는 차례대로. 2026-10-09 에 사용자가 손으로 맞춘 값이다. 새 지면은 화면의 "손으로 정답 맞추기"로 만든 뒤 여기에 옮겨 적는다.
 */
const KNOWN_TRUTH: Record<string, { start: number; boxes: [number, number, number, number][] }> = {
  "IMG_2209.jpeg": { start: 12, boxes: [[0.141, 0.229, 0.788, 0.68]] },
  "IMG_2319.jpeg": {
    start: 11,
    boxes: [
      [0.124, 0.077, 0.394, 0.239],
      [0.11, 0.321, 0.412, 0.263],
      [0.082, 0.575, 0.453, 0.354],
      [0.522, 0.057, 0.423, 0.453],
      [0.543, 0.523, 0.427, 0.384],
    ],
  },
};

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
  const [refine, setRefine] = useState(false);
  /** 글자에 맞춰 다듬기(`snapPageProblems`). 끄면 최종 = 모델 박스 그대로(서버 넓힘만). */
  const [snap, setSnap] = useState(false);
  const [refineEffort, setRefineEffort] = useState<"low" | "medium" | "high">("medium");
  const [results, setResults] = useState<Record<string, Res>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [ran, setRan] = useState<Cand[]>([]);

  // 결과를 보고 "패스"(남김 표시) / "실패"(목록에서 지움)를 고른다. 지운 것은 기기에 기억해 다음에도 안 나온다.
  const [marks, setMarks] = useState<Record<string, "pass">>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  /** 손으로 맞춘 정답 박스(지면별, 읽는 차례 = 그린 차례). 모델과의 오차를 결과 복사에 수치로 싣는다. */
  const [truth, setTruth] = useState<Record<string, EditBox[]>>({});
  const [truthStart, setTruthStart] = useState<Record<string, number>>({});
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

  async function attachPages(out: Page[]) {
    setPages((p) => [...p, ...out]);
    for (const pg of out) {
      const k = KNOWN_TRUTH[pg.name];
      if (!k) continue;
      setTruthStart((m) => ({ ...m, [pg.id]: k.start }));
      setTruth((m) => ({
        ...m,
        [pg.id]: k.boxes.map(([x, y, w, h], i) => ({ id: `k${pg.id}${i}`, group: `k${i}`, x, y, w, h })),
      }));
    }
  }

  // ── 샘플 보관함(R2): 비교용 지면을 한 번 올려 두면 다음에 열 때 저절로 불러온다(최대 4장). 경로 `<내 id>/_compare/…`, 목록은 index.json.
  type Sample = { name: string; path: string; type: string };
  const [samples, setSamples] = useState<Sample[]>([]);
  const [vaultMsg, setVaultMsg] = useState("");
  const vaultInit = useRef(false);

  async function vaultPaths() {
    const { data } = await createClient().auth.getUser();
    const uid = data.user?.id;
    if (!uid) throw new Error("로그인이 필요해요.");
    return { uid, index: `${uid}/_compare/index.json` };
  }
  async function readIndex(): Promise<Sample[]> {
    const { index } = await vaultPaths();
    try {
      const res = await fetch(`/api/card/${index}`, { cache: "no-store" });
      if (!res.ok) return [];
      const j = JSON.parse(await res.text()) as unknown;
      return Array.isArray(j)
        ? j.filter((x): x is Sample => !!x && typeof x.name === "string" && typeof x.path === "string").slice(0, 4)
        : [];
    } catch {
      return [];
    }
  }
  async function writeIndex(list: Sample[]) {
    const { index } = await vaultPaths();
    const r = await putBlob(createClient(), index, new Blob([JSON.stringify(list)], { type: "application/json" }), "application/json");
    if (!r.ok) throw new Error(r.error);
    setSamples(list);
  }
  async function loadSamples(list: Sample[], skipNames: Set<string>) {
    const out: Page[] = [];
    for (const sm of list) {
      if (skipNames.has(sm.name)) continue;
      try {
        const res = await fetch(`/api/card/${sm.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        out.push(await prepare(new File([blob], sm.name, { type: sm.type || blob.type || "image/jpeg" })));
      } catch (err) {
        setVaultMsg(`${sm.name}: ${err instanceof Error ? err.message : "불러오지 못함"}`);
      }
    }
    if (out.length) await attachPages(out);
  }
  async function saveToVault() {
    setVaultMsg("보관함에 올리는 중…");
    try {
      const { uid } = await vaultPaths();
      const cur = await readIndex();
      const next = [...cur];
      for (const p of pages) {
        if (next.some((x) => x.name === p.name)) continue;
        if (next.length >= 4) {
          setVaultMsg("보관함은 4장까지예요. 하나를 지우고 다시 저장해 주세요.");
          break;
        }
        const path = `${uid}/_compare/${Date.now()}-${next.length}.jpg`;
        const type = p.file.type || "image/jpeg";
        const r = await putBlob(createClient(), path, p.file, type);
        if (!r.ok) throw new Error(r.error);
        next.push({ name: p.name, path, type });
      }
      await writeIndex(next);
      setVaultMsg(`보관함 ${next.length}장 — 다음에 열 때 자동으로 불러와요.`);
    } catch (err) {
      setVaultMsg(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async function removeSample(sm: Sample) {
    try {
      await writeIndex(samples.filter((x) => x.path !== sm.path));
      await removeBlobs([sm.path]);
      setVaultMsg(`${sm.name} 을(를) 보관함에서 지웠어요.`);
    } catch (err) {
      setVaultMsg(`지우기 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  useEffect(() => {
    if (vaultInit.current) return;
    vaultInit.current = true;
    void (async () => {
      try {
        const list = await readIndex();
        setSamples(list);
        if (list.length) {
          setVaultMsg(`보관함 ${list.length}장을 불러오는 중…`);
          await loadSamples(list, new Set());
          setVaultMsg(`보관함 ${list.length}장을 불러왔어요.`);
        }
      } catch {
        /* 로그인 안 됐거나 보관함 없음 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    await attachPages(out);
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
        const t = truth[p.id];
        if (t?.length) {
          const st = truthStart[p.id] ?? 1;
          // 모델 − 정답, %p. 위·아래·왼쪽·오른쪽 변 각각(+면 모델이 더 아래/오른쪽 = 위·왼쪽은 안쪽으로 잘림, 아래·오른쪽은 바깥으로 넉넉).
          const delta = (list: DetectedProblem[] | undefined, label: string) => {
            const errs: number[] = [];
            t.forEach((tb, i) => {
              const no = String(st + i);
              const pr = (list ?? []).find((q) => q.no === no) ?? (list ?? [])[i];
              const bs = pr?.boxes ?? [];
              if (!bs.length) {
                out.push(`  - ${label} Δ ${no}번: 못 찾음`);
                return;
              }
              const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
              const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
              const d = [y0 - tb.y, y1 - (tb.y + tb.h), x0 - tb.x, x1 - (tb.x + tb.w)].map((v) => v * 100);
              errs.push(...d.map(Math.abs));
              out.push(`  - ${label} Δ ${no}번 (위,아래,왼,오른 %p): ${d.map((v) => (v > 0 ? "+" : "") + v.toFixed(1)).join(", ")}`);
            });
            if (errs.length) out.push(`  - ${label} 변 평균 절대 오차 ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)}%p · 최대 ${Math.max(...errs).toFixed(1)}%p`);
          };
          delta(r.raw, "모델");
          if (r.final && r.final !== r.raw) delta(r.final, "최종(다듬은 뒤)");
        }
        out.push("");
      }
      const t = truth[p.id];
      if (t?.length) {
        out.push(`### 손으로 맞춘 정답 (${p.name}, 지면 대비 % — x,y,w,h · 변: 위,아래,왼,오른)`);
        t.forEach((b, i) => {
          out.push(`  - ${(truthStart[p.id] ?? 1) + i}번: [${f1(b.x)},${f1(b.y)},${f1(b.w)},${f1(b.h)}] · 변 ${f1(b.y)},${f1(b.y + b.h)},${f1(b.x)},${f1(b.x + b.w)}`);
        });
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
      const final = snap ? snapPageProblems(img, src.width, src.height, found).problems : found;
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
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-medium text-slate-700">샘플 보관함 {samples.length}/4</span>
          <Button type="button" variant="outline" size="xs" disabled={pages.length === 0} onClick={() => void saveToVault()}>
            지금 지면을 보관함에 저장
          </Button>
          {samples.map((sm) => (
            <span key={sm.path} className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-2 py-0.5">
              {sm.name}
              <button type="button" title="보관함에서 지우기" className="text-slate-400 hover:text-red-600" onClick={() => void removeSample(sm)}>
                ×
              </button>
            </span>
          ))}
          {vaultMsg && <span className="text-slate-500">{vaultMsg}</span>}
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
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="h-4 w-4 accent-blue-600" />
          글자에 맞춰 다듬기(끄면 최종 = 모델 박스 그대로)
        </label>
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
          <details className="rounded-lg border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              손으로 정답 맞추기 {truth[p.id]?.length ? `(${truth[p.id].length}개)` : ""} — 맞춘 수치가 결과 복사에 모델별 오차(Δ)와 함께 실려요
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                첫 문제 번호
                <Input
                  type="number"
                  value={truthStart[p.id] ?? 1}
                  onChange={(e) => setTruthStart((m) => ({ ...m, [p.id]: Number(e.target.value) || 1 }))}
                  className="h-7 w-20 text-xs"
                />
                <span>읽는 차례(왼쪽 단 위→아래, 오른쪽 단)대로 번호가 매겨져요.</span>
                {(ran.length ? ran : chosen)
                  .filter((c) => !removed.has(c.key) && results[`${p.id}|${c.key}`]?.raw?.length)
                  .map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      className="rounded-full border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
                      onClick={() => {
                        const raw = results[`${p.id}|${c.key}`]?.raw ?? [];
                        const first = Number(raw[0]?.no);
                        if (Number.isFinite(first) && first > 0) setTruthStart((m) => ({ ...m, [p.id]: first }));
                        setTruth((m) => ({
                          ...m,
                          [p.id]: raw.flatMap((q, i) => q.boxes.slice(0, 1).map((b, j) => ({ id: `t${Date.now()}${i}${j}`, group: `t${i}`, x: b.x, y: b.y, w: b.w, h: b.h }))),
                        }));
                      }}
                    >
                      {nameOf(c)} 결과에서 시작
                    </button>
                  ))}
                <button type="button" className="rounded-full border border-slate-300 px-2 py-0.5 hover:bg-slate-50" onClick={() => setTruth((m) => ({ ...m, [p.id]: [] }))}>
                  비우기
                </button>
              </div>
              <div className="max-w-xl">
                <BoxEditor
                  image={p.view}
                  boxes={truth[p.id] ?? []}
                  onChange={(b) => setTruth((m) => ({ ...m, [p.id]: b }))}
                  labelOf={(g) => {
                    const i = (truth[p.id] ?? []).findIndex((b) => b.group === g);
                    return i < 0 ? "" : `${(truthStart[p.id] ?? 1) + i}번`;
                  }}
                />
              </div>
              {(truth[p.id] ?? []).length > 0 && (
                <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-700">
                  {(truth[p.id] ?? [])
                    .map((b, i) => `${(truthStart[p.id] ?? 1) + i}번: x ${(b.x * 100).toFixed(1)} y ${(b.y * 100).toFixed(1)} w ${(b.w * 100).toFixed(1)} h ${(b.h * 100).toFixed(1)}  (변 위 ${(b.y * 100).toFixed(1)} · 아래 ${((b.y + b.h) * 100).toFixed(1)} · 왼 ${(b.x * 100).toFixed(1)} · 오른 ${((b.x + b.w) * 100).toFixed(1)})`)
                    .join("\n")}
                </pre>
              )}
            </div>
          </details>
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
