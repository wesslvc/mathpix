"use client";

import { useState } from "react";
import { buildKicePdf } from "@/lib/kice/pdf";
import { frameKeyFor, loadFrameImages, loadKiceFrames, type KiceArea } from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import { KICE_AREAS } from "@/lib/kiceSubjects";

/**
 * **임시 화면입니다. 다 쓰면 이 폴더째 지우세요.**
 *
 *     rm -rf src/app/kice-answer-temp
 *
 * 정답표만 한 쪽 뽑는다. 평소 내보내기(`/export`)는 실모에 저장된 문제를
 * 깔고 그 뒤에 정답표를 붙이는데, 여기서는 **문제 없이 정답표 쪽만** 만든다
 * (`buildKicePdf` 에 problems 를 비워 넘기면 정답표 한 쪽만 나온다).
 *
 * 글꼴이 이 화면의 존재 이유다 — 정답표는 `(한)신중명조` 로 그려지는데 그
 * 글꼴은 배포권이 없어 저장소가 아니라 Supabase 비공개 버킷에 있다. 로그인한
 * 브라우저에서만 받을 수 있어서, 밖에서 만든 PDF 는 서체가 다르다.
 */

/** 2027학년도 9월 모의평가 국어 — 뽑고 싶은 문항만. 여기만 고치면 된다. */
const DEFAULT_ROWS = [
  { no: 5, answer: "④" },
  { no: 17, answer: "⑤" },
  { no: 23, answer: "①" },
  { no: 27, answer: "①" },
  { no: 37, answer: "②" },
  { no: 38, answer: "③" },
  { no: 39, answer: "④" },
];

export default function KiceAnswerTempPage() {
  const [area, setArea] = useState<KiceArea>("국어");
  const [title, setTitle] = useState("2027학년도 대학수학능력시험 9월 모의평가 문제지");
  const [text, setText] = useState(
    DEFAULT_ROWS.map((r) => `${r.no} ${r.answer}`).join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** "번호 정답" 을 줄마다 읽는다. 구분자는 공백·탭·쉼표 아무거나. */
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.split(/[\s,\t]+/);
      return { label: `${m[0]}번`, answer: m.slice(1).join(" ") };
    })
    .filter((r) => r.answer);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const [all, fonts] = await Promise.all([loadKiceFrames(), loadKiceFonts()]);
      const frames = all[frameKeyFor(area)];
      const images = await loadFrameImages(frames);

      const replace: Record<string, string> = {};
      if (title.trim()) replace["2025학년도대학수학능력시험문제지"] = title.trim();
      // 탐구 틀은 영역명이 "사회탐구"로 박혀 있어 갈아끼워야 한다.
      if (frameKeyFor(area) === "tamgu") {
        replace["사회탐구영역"] = `${area} 영역`;
        replace["(사회문화)"] = "";
      }

      const bytes = await buildKicePdf({
        frames,
        replace,
        fonts,
        images,
        problems: [], // 문제 없이 정답표 쪽만
        pagePattern: [1],
        answers: rows,
      });

      const blob = new Blob([bytes.slice().buffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${area} 정답표.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-10">
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <b>임시 화면입니다.</b> 다 쓰면 알려주세요 — 이 폴더째 지우겠습니다.
      </div>

      <h1 className="text-xl font-semibold text-ink">정답표만 뽑기 (평가원 양식)</h1>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        영역
        <select
          value={area}
          onChange={(e) => setArea(e.target.value as KiceArea)}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          {KICE_AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        표지 제목
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        정답 (한 줄에 &quot;번호 정답&quot;)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          className="rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-sm"
        />
        <span className="text-xs text-slate-400">
          지금 {rows.length}개. 원숫자는 ① ② ③ ④ ⑤ 를 그대로 붙여 넣으세요.
        </span>
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={() => void make()}
        disabled={busy || rows.length === 0}
        className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "만드는 중..." : "PDF 내려받기"}
      </button>
    </main>
  );
}
