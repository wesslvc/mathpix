"use client";

import { useEffect, useState } from "react";
import { enhanceContrast } from "@/lib/autoContrast";
import { isHeicFile, loadImage } from "@/lib/cropImage";
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
  label: string;
  provider: "openai" | "gemini";
  model: string;
  effort: string;
};

// 둘 다 2026-09-25 probe 로 확인했다: `gemini-3.8-flash` 는 이 키의 ListModels 에
// 있고, gpt-6-luna 의 추론 강도는 none·minimal·low·medium·high·xhigh·max 를 받는다.
const DEFAULT_READERS: Reader[] = [
  { key: "a", label: "Luna Max", provider: "openai", model: "gpt-6-luna", effort: "max" },
  { key: "b", label: "Gemini 3.8 Flash", provider: "gemini", model: "gemini-3.8-flash", effort: "" },
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
      circledFixed: number;
      circledMismatch: boolean;
      pdfUrl: string;
      chars: number;
    }
  | { state: "error"; message: string; ms?: number };

/** 모델에 보낼 사진. 긴 변 2600px·JPEG 90 — 두 모델에 같은 것을 보낸다. */
async function fileToModelImage(file: File): Promise<string> {
  if (isHeicFile(file)) throw new Error("HEIC 는 열 수 없습니다. JPG/PNG 로 올려주세요.");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    // Vercel 본문 한도(4.5MB) 안에 들어갈 때까지 줄인다.
    for (const max of [2600, 2200, 1800, 1600]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("캔버스를 만들 수 없습니다.");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.9);
      if (data.length < 3_300_000) return data;
    }
    throw new Error("사진이 너무 큽니다.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

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

export default function CompareKoreanPage() {
  const [readers, setReaders] = useState<Reader[]>(DEFAULT_READERS);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [useReference, setUseReference] = useState(true);
  const [reference, setReference] = useState<string | null>(null);
  const [refState, setRefState] = useState<"idle" | "running" | "ok" | "failed" | "off">("idle");
  const [results, setResults] = useState<Record<string, Result>>({ a: { state: "idle" }, b: { state: "idle" } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patchReader(key: Reader["key"], patch: Partial<Reader>) {
    setReaders((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function pick(f: File | null) {
    setFile(f);
    setReference(null);
    setRefState("idle");
    setResults({ a: { state: "idle" }, b: { state: "idle" } });
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
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
      const json = (await res.json().catch(() => ({}))) as {
        blocks?: unknown;
        model?: string;
        ms?: number;
        usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
        error?: string;
      };
      if (!res.ok) {
        throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { ms: json.ms });
      }
      const raw = readRichBlocks(json.blocks);
      if (raw.length === 0) throw new Error("문단을 하나도 읽지 못했습니다.");
      // 운영과 똑같이 원문자를 참고 글에 맞춘다 — 여기만 다르면 견준 결과가 운영과 어긋난다.
      const { blocks, replaced, matched } = alignCircledToReference(raw, ref);
      const model = json.model ?? reader.model;
      const tag = reader.provider === "openai" && reader.effort ? `${model} (${reader.effort})` : model;
      const pdfUrl = await makePdf(blocks, `지문 비교 — ${reader.label}`, `2p, ${tag}`);
      setResults((r) => ({
        ...r,
        [reader.key]: {
          state: "done",
          blocks,
          model: tag,
          ms: json.ms ?? Date.now() - since,
          usage: json.usage,
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
      const image = await enhanceContrast(await fileToModelImage(file));
      let ref = "";
      if (useReference) {
        if (reference != null) {
          ref = reference;
        } else {
          setRefState("running");
          try {
            ref = await readReference(image);
            setReference(ref);
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
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="지문" className="max-h-64 w-auto self-start rounded border" />
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
                ? `✓ ${reference?.length ?? 0}자`
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
              <h2 className="font-semibold text-slate-900">{reader.label}</h2>
              <div className="flex flex-wrap gap-2 text-xs">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-slate-600">
                  모델 ({reader.provider === "openai" ? "OpenAI" : "Gemini"})
                  <input
                    value={reader.model}
                    onChange={(e) => patchReader(reader.key, { model: e.target.value })}
                    className="rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </label>
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
