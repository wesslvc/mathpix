"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cardUrl } from "@/lib/cardUrl";
import { fileToDataUrl } from "@/lib/cropImage";
import { ensureDataUrl, imageSizeOf, prepareProblemForModel } from "@/lib/figureImage";
import type { VariantPlan } from "@/lib/variantPlan";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * **변형문제 생성**(시험 중 — 무제한 계정 전용).
 *
 * 입력은 두 갈래다: 내 실모(폴더 → 실모 → 문제 고르기) 또는 문제 사진 올리기. 문제마다
 *  ① sol 이 문제를 이해하고 풀어서 핵심 논리·계산은 두고 숫자만 바꾼 변형을 설계 → 그림 모델에 줄 편집 지시를 만든다
 *  ② sunburst 가 **원본 문제 이미지 + 그 지시**로 이미지를 고쳐 그린다(그림·도표도 새 숫자에 맞게 고친다).
 * 결과는 원본과 나란히 보이고, sol 이 이해한 것·바꾼 값·새 정답·보낸 편집 지시를 펼쳐 볼 수 있다.
 */

type Folder = { id: string; name: string };
type Cat = { id: string; source: string; folder_id: string | null };
type Prob = { id: string; image_path: string; problemNo: number | null; sort_order: number | null };

type Item = {
  key: string;
  label: string;
  /** 원본 그림 — 실모 문제는 주소, 올린 사진은 data URL. */
  src: string;
};
type Run = {
  key: string;
  label: string;
  stage: "prep" | "plan" | "draw" | "done" | "error";
  original?: string;
  plan?: VariantPlan;
  image?: string;
  error?: string;
  krw: number;
  ms?: number;
};

const QUALITIES = ["auto", "low", "medium", "high"];
const won = (n: number) => `${Math.round(n).toLocaleString()}원`;

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/variant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function waitPlan(jobId: string): Promise<{ plan: VariantPlan; estKrw: number | null }> {
  const until = Date.now() + 20 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let poll: { status?: string; message?: string; error?: string; plan?: VariantPlan; estKrw?: number | null };
    try {
      const res = await fetch(`/api/variant?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
      poll = await res.json();
    } catch {
      if (Date.now() > until) throw new Error("20분이 지나도 끝나지 않았습니다.");
      continue;
    }
    if (poll.status === "done" && poll.plan) return { plan: poll.plan, estKrw: poll.estKrw ?? null };
    if (poll.status === "error") throw new Error(poll.message ?? poll.error ?? "실패했습니다.");
    if (Date.now() > until) throw new Error("20분이 지나도 끝나지 않았습니다.");
  }
}

export default function VariantPanel() {
  const supabase = useRef(createClient()).current;
  const [folders, setFolders] = useState<Folder[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [folderId, setFolderId] = useState<string>("");
  const [catId, setCatId] = useState<string>("");
  const [probs, setProbs] = useState<Prob[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<Item[]>([]);
  const [quality, setQuality] = useState("medium");
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [f, c] = await Promise.all([
        supabase.from("folders").select("id,name").order("name"),
        supabase.from("categories").select("id,source,folder_id").order("created_at", { ascending: false }),
      ]);
      setFolders((f.data as Folder[]) ?? []);
      setCats((c.data as Cat[]) ?? []);
    })();
  }, [supabase]);

  useEffect(() => {
    setPicked(new Set());
    if (!catId) {
      setProbs([]);
      return;
    }
    void (async () => {
      const { data, error: e } = await supabase
        .from("problems")
        .select("id,image_path,problemNo:box_range->number,korean:box_range->korean,sort_order")
        .eq("category_id", catId)
        .order("sort_order", { ascending: true });
      if (e) {
        setError(`문제를 불러오지 못했어요: ${e.message}`);
        return;
      }
      // 국어 지문은 변형 대상이 아니다.
      const rows = ((data as unknown as (Prob & { korean?: { role?: string } | null })[]) ?? []).filter(
        (p) => p.korean?.role !== "passage",
      );
      setProbs(rows);
    })();
  }, [catId, supabase]);

  const shownCats = cats.filter((c) => (folderId === "" ? true : folderId === "_none" ? !c.folder_id : c.folder_id === folderId));

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const out: Item[] = [];
    for (const f of Array.from(files)) {
      try {
        out.push({ key: `up:${f.name}:${f.size}:${f.lastModified}`, label: f.name, src: await fileToDataUrl(f) });
      } catch {
        setError(`${f.name} 을(를) 열지 못했어요.`);
      }
    }
    setUploads((u) => [...u, ...out]);
  }

  const items: Item[] = [
    ...probs
      .filter((p) => picked.has(p.id))
      .map((p) => ({
        key: `p:${p.id}`,
        label: `${cats.find((c) => c.id === catId)?.source ?? "실모"} ${p.problemNo != null ? `${p.problemNo}번` : "(번호 없음)"}`,
        src: cardUrl(p.image_path),
      })),
    ...uploads,
  ];

  function patch(key: string, p: Partial<Run>) {
    setRuns((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }

  async function runOne(item: Item) {
    const t0 = Date.now();
    let krw = 0;
    try {
      const original = await prepareProblemForModel(await ensureDataUrl(item.src));
      const size = await imageSizeOf(original);
      patch(item.key, { original, stage: "plan" });
      const { jobId } = await postJson<{ jobId: string }>({ task: "plan", image: original });
      const { plan, estKrw } = await waitPlan(jobId);
      krw += estKrw ?? 0;
      patch(item.key, { plan, stage: "draw", krw });
      const gen = await postJson<{ image: string; usage: { estKrw?: number } | null }>({
        task: "generate",
        image: original,
        edits: plan.edits,
        width: size?.width,
        height: size?.height,
        quality: quality === "auto" ? undefined : quality,
      });
      krw += gen.usage?.estKrw ?? 0;
      patch(item.key, { image: gen.image, stage: "done", krw, ms: Date.now() - t0 });
    } catch (err) {
      patch(item.key, { stage: "error", error: err instanceof Error ? err.message : "실패했습니다.", krw });
    }
  }

  async function start() {
    if (!items.length) return;
    setError(null);
    setBusy(true);
    setRuns(items.map((i) => ({ key: i.key, label: i.label, stage: "prep", krw: 0 })));
    // 동시에 3개까지.
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) await runOne(it);
      }),
    );
    setBusy(false);
  }

  const stageText: Record<Run["stage"], string> = {
    prep: "준비 중",
    plan: "sol 이 문제를 이해하고 변형을 설계하는 중",
    draw: "sunburst 가 원본을 바탕으로 고쳐 그리는 중",
    done: "완료",
    error: "실패",
  };

  return (
    <div className="flex flex-col gap-4">
      <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
        <h2 className="text-sm font-semibold text-ink">1. 원본 문제 고르기</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            폴더
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-ink"
              value={folderId}
              onChange={(e) => {
                setFolderId(e.target.value);
                setCatId("");
              }}
            >
              <option value="">전체</option>
              <option value="_none">폴더 없음</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            실모
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-ink"
              value={catId}
              onChange={(e) => setCatId(e.target.value)}
            >
              <option value="">선택…</option>
              {shownCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.source}
                </option>
              ))}
            </select>
          </label>
        </div>

        {probs.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>{picked.size}개 선택</span>
              <button className="underline" onClick={() => setPicked(new Set(probs.map((p) => p.id)))}>
                전체 선택
              </button>
              <button className="underline" onClick={() => setPicked(new Set())}>
                해제
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {probs.map((p) => {
                const on = picked.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (n.has(p.id)) n.delete(p.id);
                        else n.add(p.id);
                        return n;
                      })
                    }
                    className={cn(
                      "overflow-hidden rounded-lg border bg-white text-left",
                      on ? "border-blue-500 ring-2 ring-blue-200" : "border-slate-200",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cardUrl(p.image_path)} alt="" className="h-28 w-full object-cover object-top" loading="lazy" />
                    <div className="px-2 py-1 text-xs text-slate-600">{p.problemNo != null ? `${p.problemNo}번` : "번호 없음"}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="border-t border-slate-100 pt-3">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            또는 문제 사진 올리기(여러 장 가능)
            <input type="file" accept="image/*" multiple onChange={(e) => void onFiles(e.target.files)} className="text-sm" />
          </label>
          {uploads.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
              {uploads.map((u) => (
                <li key={u.key} className="rounded-full bg-slate-100 px-2 py-1">
                  {u.label}{" "}
                  <button className="text-slate-400" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={cn(cardClass, "flex flex-wrap items-center gap-3 p-4 sm:p-5")}>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          그림 품질
          <select
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
          >
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void start()} disabled={busy || items.length === 0}>
          {busy ? "만드는 중…" : `변형문제 만들기 (${items.length}개)`}
        </Button>
        <span className="text-xs text-slate-500">
          문제마다 sol 이해·설계 → sunburst 편집. 토큰은 안 떼고 원가만 아래에 보여요(시험 중).
        </span>
      </section>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {runs.map((r) => (
        <section key={r.key} className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">{r.label}</h3>
            <span className={cn("text-xs", r.stage === "error" ? "text-red-600" : r.stage === "done" ? "text-emerald-600" : "text-slate-500")}>
              {stageText[r.stage]}
              {r.krw > 0 && ` · ${won(r.krw)}`}
              {r.ms != null && ` · ${(r.ms / 1000).toFixed(0)}초`}
            </span>
          </div>
          {r.error && <p className="text-sm text-red-700">{r.error}</p>}
          {(r.original || r.image) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs text-slate-500">원본</figcaption>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {r.original && <img src={r.original} alt="원본" className="w-full rounded border border-slate-200" />}
              </figure>
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs text-slate-500">변형</figcaption>
                {r.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.image} alt="변형" className="w-full rounded border border-blue-200" />
                ) : (
                  <div className="flex h-32 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">
                    {r.error ? "만들지 못했어요" : "만드는 중…"}
                  </div>
                )}
              </figure>
            </div>
          )}
          {r.plan && (
            <details className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700" open={r.stage === "done"}>
              <summary className="cursor-pointer text-xs font-semibold text-slate-600">
                sol 이 이해한 것 · 바꾼 값 · 새 정답
              </summary>
              <p className="mt-2">{r.plan.summary}</p>
              {r.plan.keeps.length > 0 && <p className="mt-1 text-xs text-slate-500">그대로: {r.plan.keeps.join(" / ")}</p>}
              <ul className="mt-2 list-disc pl-5 text-xs">
                {r.plan.changes.map((c, i) => (
                  <li key={i}>
                    <b>{c.from}</b> → <b>{c.to}</b>
                    {c.why && <span className="text-slate-500"> — {c.why}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">
                정답: {r.plan.originalAnswer || "?"} → <b>{r.plan.newAnswer || "?"}</b>
              </p>
              {r.plan.solution && <pre className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{r.plan.solution}</pre>}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-slate-500">그림 모델에 보낸 편집 지시</summary>
                <pre className="mt-1 whitespace-pre-wrap text-xs">{r.plan.edits}</pre>
              </details>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
