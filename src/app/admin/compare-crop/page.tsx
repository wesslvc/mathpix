"use client";

import { useState } from "react";
import { cropImageToDataUrl, loadDrawableFromFile, loadImage } from "@/lib/cropImage";
import { enhanceContrast } from "@/lib/autoContrast";
import { refineAiBox } from "@/lib/autoCrop";
import { cropRegionToDataUrl, type Region } from "@/lib/polygon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * **자동 자르기 비교**(2026-10-09, 사용자 — "자동 자르기 비교 화면 만들어 줘"). 무제한 계정 전용, 토큰 안 뗌.
 *
 * 사진을 여러 장 올리고 견줄 모델을 고르면 사진 × 모델마다 운영과 **같은 자동 자르기**(`cropOneProblem` — 같은 프롬프트·번호·선지
 * 확인·선지 다시 묻기)를 동시에 부른다. 보내는 그림도 운영과 같다(긴 변 2048 + 대비 올리기). 카드마다:
 *   - 점선 = 모델이 준 자리(번호·선지까지 합친 것), 실선 = 화면이 글자에 맞춰 다듬은 **실제로 잘리는 자리**(`refineAiBox`),
 *     작은 주황 네모 = 모델이 짚은 번호·선지
 *   - 실제로 잘린 그림, 걸린 시간(화면에서 잰 왕복), 토큰, 원가(단가를 아는 모델만), 번호·선지 수·다시 물었는지·회전·추천
 * 맨 아래 표가 모델마다 평균 시간·선지 다섯 개 찾은 비율·번호 찾은 비율·원가 합계를 모은다.
 */

type Cand = { key: string; engine: "gemini" | "openai"; model: string; effort?: string };

const PRESETS: Cand[] = [
  { key: "g35l", engine: "gemini", model: "gemini-3.5-flash-lite" },
  { key: "gfll", engine: "gemini", model: "gemini-flash-lite-latest" },
  { key: "g38", engine: "gemini", model: "gemini-3.8-flash" },
  { key: "gfl", engine: "gemini", model: "gemini-flash-latest" },
  { key: "lunaL", engine: "openai", model: "gpt-6-luna", effort: "low" },
  { key: "lunaM", engine: "openai", model: "gpt-6-luna", effort: "medium" },
  { key: "lunaH", engine: "openai", model: "gpt-6-luna", effort: "high" },
];
const DEFAULT_ON = new Set(["g35l", "g38", "lunaH"]);

const nameOf = (c: Cand) => (c.effort ? `${c.model} (${c.effort})` : c.model);

type Res = {
  state: "running" | "done" | "error";
  ms?: number;
  error?: string;
  box?: (Region & { keep?: Region[] }) | null;
  final?: Region | null;
  cut?: string | null;
  number?: string | null;
  choices?: number;
  retried?: boolean;
  rotate?: number;
  advice?: string | null;
  adviceReason?: string | null;
  usage?: { input: number; cached: number; output: number } | null;
  estKrw?: number | null;
};

type Photo = { id: string; name: string; image: string; w: number; h: number };

/** 운영 자동 자르기와 같은 그림: 긴 변 2048 + 대비 올리기. */
async function prepare(file: File): Promise<Photo> {
  const d = await loadDrawableFromFile(file);
  try {
    const raw = cropImageToDataUrl(d.src, { x: 0, y: 0, width: d.width, height: d.height }, { maxWidth: 2048, maxHeight: 2048 });
    const image = await enhanceContrast(raw);
    const img = await loadImage(image);
    return { id: crypto.randomUUID(), name: file.name, image, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    d.close();
  }
}

export default function CompareCropPage() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set(DEFAULT_ON));
  const [custom, setCustom] = useState<Cand[]>([]);
  const [customText, setCustomText] = useState("");
  const [results, setResults] = useState<Record<string, Res>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [ran, setRan] = useState<Cand[]>([]);

  const cands = [...PRESETS, ...custom];
  const chosen = cands.filter((c) => on.has(c.key));

  async function pick(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy("사진을 준비하는 중…");
    const out: Photo[] = [];
    for (const f of list) {
      try {
        out.push(await prepare(f));
      } catch (err) {
        alert(`${f.name}: ${err instanceof Error ? err.message : "열지 못함"}`);
      }
    }
    setPhotos((p) => [...p, ...out]);
    setBusy(null);
  }

  function addCustom() {
    const t = customText.trim();
    if (!t) return;
    const [model, effort] = t.split(/\s+/);
    const engine: Cand["engine"] = model.startsWith("gemini") ? "gemini" : "openai";
    const key = `c${Date.now()}`;
    setCustom((c) => [...c, { key, engine, model, ...(effort && engine === "openai" ? { effort } : {}) }]);
    setOn((s) => new Set(s).add(key));
    setCustomText("");
  }

  async function runOne(p: Photo, c: Cand) {
    const k = `${p.id}|${c.key}`;
    setResults((r) => ({ ...r, [k]: { state: "running" } }));
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
        setResults((r) => ({ ...r, [k]: { state: "error", ms, error: j.error ?? `HTTP ${res.status}` } }));
        return;
      }
      let final: Region | null = null;
      let cut: string | null = null;
      if (j.box) {
        const img = await loadImage(p.image);
        final = refineAiBox(img, j.box, img.naturalWidth, img.naturalHeight);
        cut = cropRegionToDataUrl(img, final, 0);
      }
      setResults((r) => ({ ...r, [k]: { state: "done", ...j, ms, final, cut } }));
    } catch (err) {
      setResults((r) => ({
        ...r,
        [k]: { state: "error", ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  async function runAll() {
    if (!photos.length || !chosen.length) return;
    setRan(chosen);
    setResults({});
    await Promise.all(photos.flatMap((p) => chosen.map((c) => runOne(p, c))));
  }

  const summary = ran.map((c) => {
    const rs = photos.map((p) => results[`${p.id}|${c.key}`]).filter((r): r is Res => !!r && r.state !== "running");
    const done = rs.filter((r) => r.state === "done");
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      c,
      n: rs.length,
      errors: rs.length - done.length,
      ms: avg(rs.map((r) => r.ms ?? 0)),
      five: done.filter((r) => (r.choices ?? 0) >= 5).length,
      num: done.filter((r) => r.number).length,
      none: done.filter((r) => !r.box).length,
      krw: done.reduce((a, r) => a + (r.estKrw ?? 0), 0),
      krwKnown: done.some((r) => r.estKrw != null),
      outTok: avg(done.map((r) => r.usage?.output ?? 0)),
    };
  });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">자동 자르기 비교</h1>
        <p className="text-xs text-slate-500">
          운영 자동 자르기와 같은 프롬프트·같은 그림(긴 변 2048 + 대비)으로 모델만 바꿔 자릅니다. 점선 = 모델이 준 자리, 실선 = 글자에
          맞춰 다듬은 실제로 잘리는 자리, 주황 = 짚은 번호·선지. 토큰은 차감하지 않아요.
        </p>
      </div>

      <section className={cn(cardClass, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept="image/*" multiple onChange={(e) => void pick(e.target.files)} className="g-file min-w-0 flex-1" />
          {photos.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { setPhotos([]); setResults({}); }}>
              사진 비우기 ({photos.length}장)
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
            placeholder="다른 모델: gemini-3.6-flash 또는 gpt-6-luna xhigh"
            className="min-w-0 flex-1"
          />
          <Button type="button" variant="outline" size="sm" onClick={addCustom}>
            추가
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Button type="button" variant="primary" disabled={!photos.length || !chosen.length || busy !== null} onClick={() => void runAll()}>
            {photos.length}장 × {chosen.length}개 모델 자르기
          </Button>
          {busy && <span className="text-xs text-slate-500">{busy}</span>}
        </div>
      </section>

      {summary.length > 0 && (
        <section className={cn(cardClass, "overflow-x-auto p-4")}>
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1">모델</th>
                <th>평균 시간</th>
                <th>선지 5개</th>
                <th>번호 찾음</th>
                <th>못 찾음</th>
                <th>실패</th>
                <th>평균 출력 토큰</th>
                <th>원가 합계</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.c.key} className="border-t border-slate-100">
                  <td className="py-1.5 font-medium">{nameOf(s.c)}</td>
                  <td>{s.ms != null ? `${(s.ms / 1000).toFixed(1)}초` : "…"}</td>
                  <td>{s.five}/{s.n - s.errors}</td>
                  <td>{s.num}/{s.n - s.errors}</td>
                  <td>{s.none}</td>
                  <td className={s.errors ? "text-red-600" : ""}>{s.errors}</td>
                  <td>{s.outTok != null ? Math.round(s.outTok) : "–"}</td>
                  <td>{s.krwKnown ? `${s.krw.toFixed(1)}원` : "단가 모름"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {photos.map((p) => (
        <section key={p.id} className="flex flex-col gap-2">
          <h2 className="truncate text-sm font-medium text-slate-700">
            {p.name} <span className="text-xs text-slate-400">{p.w}×{p.h}</span>
          </h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
            {(ran.length ? ran : chosen).map((c) => {
              const r = results[`${p.id}|${c.key}`];
              return (
                <div key={c.key} className={cn(cardClass, "flex w-72 shrink-0 flex-col gap-2 p-2")}>
                  <div className="text-xs font-semibold text-slate-700">{nameOf(c)}</div>
                  <div className="relative w-full bg-slate-100" style={{ aspectRatio: `${p.w} / ${p.h}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.image} alt="" className="absolute inset-0 h-full w-full" />
                    {r?.box && <Rect b={r.box} className="border-2 border-dashed border-blue-500" />}
                    {r?.box?.keep?.map((k, i) => <Rect key={i} b={k} className="border border-orange-500 bg-orange-400/15" />)}
                    {r?.final && <Rect b={r.final} className="border-2 border-emerald-600" />}
                    {r?.state === "running" && (
                      <span className="absolute inset-0 flex items-center justify-center bg-white/40">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
                      </span>
                    )}
                  </div>
                  {r?.cut && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.cut} alt="잘린 결과" className="max-h-56 w-full rounded border border-slate-200 bg-white object-contain" />
                  )}
                  {r && r.state !== "running" && (
                    <div className="text-[11px] leading-relaxed text-slate-600">
                      {r.state === "error" ? (
                        <span className="text-red-600">{r.error}</span>
                      ) : (
                        <>
                          <b>{((r.ms ?? 0) / 1000).toFixed(1)}초</b>
                          {r.box ? ` · 번호 ${r.number ?? "못 봄"} · 선지 ${r.choices}개${r.retried ? " (다시 물음)" : ""}` : " · 문제를 못 찾음"}
                          {r.rotate ? ` · ${r.rotate * 90}° 돌림` : ""}
                          {r.advice && ` · ${r.advice === "asis" ? "원본 그대로" : "AI 추천"}${r.adviceReason ? `(${r.adviceReason})` : ""}`}
                          <br />
                          {r.usage && `입력 ${r.usage.input} · 출력 ${r.usage.output}`}
                          {r.estKrw != null ? ` · ${r.estKrw.toFixed(2)}원` : " · 단가 모름"}
                        </>
                      )}
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

function Rect({ b, className }: { b: Region; className: string }) {
  return (
    <span
      className={cn("pointer-events-none absolute", className)}
      style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
    />
  );
}
