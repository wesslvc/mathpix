"use client";

import { useState } from "react";
import { buildKicePdf } from "@/lib/kice/pdf";
import {
  frameKeyFor,
  loadFrameImages,
  loadKiceFrames,
  type KiceArea,
} from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import { KICE_AREAS, KICE_SUBJECTS } from "@/lib/kiceSubjects";

/**
 * 평가원 문제지 양식으로 내보내기.
 *
 * 실제 수능 문제지의 판형·머리말·쪽번호 상자를 그대로 재생한 PDF 에 오답을
 * 단을 따라 흘려 넣는다. 쪽수가 늘어나면 첫 쪽 → 짝수 쪽 → 홀수 쪽 틀이
 * 번갈아 쓰이고, 쪽번호와 전체 쪽수도 실제 쪽수에 맞춰 찍힌다.
 *
 * 글꼴은 저장소에 없다(배포권이 없다). 비공개 버킷에서 받아 오며, 아직 올라가
 * 있지 않으면 그 사실을 그대로 알려 준다.
 */

export type KiceItem = {
  id: string;
  imageUrl: string;
  label: string;
  answerLabel: string;
  answer: string;
};

type Props = {
  title: string;
  items: KiceItem[];
};

async function loadPng(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

export default function KiceExportPanel({ title, items }: Props) {
  const [area, setArea] = useState<KiceArea>("사회탐구");
  const [subject, setSubject] = useState<string>(KICE_SUBJECTS["사회탐구"][0]);
  const [showSource, setShowSource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjects = KICE_SUBJECTS[area];

  function pickArea(next: KiceArea) {
    setArea(next);
    setSubject(KICE_SUBJECTS[next][0] ?? "");
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const key = frameKeyFor(area);
      const [all, fonts] = await Promise.all([loadKiceFrames(), loadKiceFonts()]);
      const frames = all[key];
      const [images, pngs] = await Promise.all([
        loadFrameImages(frames),
        Promise.all(items.map((item) => loadPng(item.imageUrl))),
      ]);

      // 틀에 적힌 글자를 무엇으로 바꿀지. 공백을 뗀 글자로 찾는다.
      const replace: Record<string, string> = {};
      if (title.trim()) replace["2025학년도대학수학능력시험문제지"] = title.trim();
      if (key === "tamgu") {
        replace["사회탐구영역"] = `${area} 영역`;
        replace["(사회문화)"] = subject ? `(${subject})` : "";
      }

      const bytes = await buildKicePdf({
        frames,
        replace,
        fonts,
        images,
        problems: pngs.map((png, i) => ({
          png,
          label: showSource ? items[i].label : "",
        })),
      });

      const blob = new Blob([bytes.slice().buffer], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const name = `${title || "오답모음"}${subject ? ` (${subject})` : ""}`;
      link.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF 만들기에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-700">영역</span>
        <div className="flex flex-wrap gap-1">
          {KICE_AREAS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => pickArea(a)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                area === a
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      {subjects.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">과목</span>
          <div className="flex flex-wrap gap-1">
            {subjects.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSubject(s)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  subject === s
                    ? "border-blue-600 bg-blue-50 text-blue-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-100"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={showSource}
          onChange={(e) => setShowSource(e.target.checked)}
          className="h-4 w-4"
        />
        문제 위에 출처 표기
        <span className="text-xs text-slate-400">
          끄면 실제 문제지와 똑같아집니다(어디서 틀린 문제인지는 알 수 없습니다).
        </span>
      </label>

      <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
        실제 수능 문제지 판형(272×394mm, 2단)에 오답을 차례로 흘려 넣습니다. 쪽수는
        문제 양에 따라 자동으로 늘고, 쪽번호와 아래쪽 전체 쪽수도 그에 맞춰 찍힙니다.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={generate}
          disabled={busy || items.length === 0}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "PDF 만드는 중..." : "평가원 양식 PDF 만들기"}
        </button>
      </div>
    </div>
  );
}
