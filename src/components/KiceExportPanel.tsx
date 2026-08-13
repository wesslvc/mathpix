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
import { stripCardBorder } from "@/lib/kice/stripBorder";
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

/**
 * 쪽마다 몇 문제를 넣을지.
 *
 * `탐구 기본` 은 실제 수능 탐구 문제지의 배치다(20문항 4쪽: 4·6·6·4).
 * 문제가 더 많으면 이 차례를 되풀이한다. 나머지는 단순히 한 단에 몇 개씩
 * 넣을지 정하는 것이고, 한 쪽이 두 단이라 쪽당 개수는 그 두 배가 된다.
 */
const LAYOUTS = [
  { key: "tamgu", label: "탐구 기본 (4·6·6·4)", pattern: [4, 6, 6, 4] },
  // 한 쪽에 하나만. 왼쪽 단에 문제, 오른쪽 단은 통째로 풀이 공간이 된다.
  { key: "p1", label: "한 쪽에 1개", pattern: [1] },
  { key: "c1", label: "한 단에 1개", pattern: [2] },
  { key: "c2", label: "한 단에 2개", pattern: [4] },
  { key: "c3", label: "한 단에 3개", pattern: [6] },
  { key: "c4", label: "한 단에 4개", pattern: [8] },
] as const;

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
  // 예전에 저장된 문제에는 카드 테두리가 구워져 있다. 실제 문제지에는 없는
  // 네모라서 여기서 지운다.
  return stripCardBorder(new Uint8Array(await res.arrayBuffer()));
}

export default function KiceExportPanel({ title, items }: Props) {
  const [area, setArea] = useState<KiceArea>("사회탐구");
  const [subject, setSubject] = useState<string>(KICE_SUBJECTS["사회탐구"][0]);
  // 기본은 **표시하지 않음** — 실제 문제지에는 없는 글자다.
  const [showSource, setShowSource] = useState(false);
  const [layoutKey, setLayoutKey] = useState<(typeof LAYOUTS)[number]["key"]>("tamgu");
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
        pagePattern: [...(LAYOUTS.find((l) => l.key === layoutKey) ?? LAYOUTS[0]).pattern],
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

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-700">배치</span>
        <div className="flex flex-wrap gap-1">
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => setLayoutKey(l.key)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                layoutKey === l.key
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={showSource}
          onChange={(e) => setShowSource(e.target.checked)}
          className="h-4 w-4"
        />
        문제 위에 출처 표기
        <span className="text-xs text-slate-400">
          켜면 어디서 틀린 문제인지 작게 적힙니다(실제 문제지에는 없는 글자입니다).
        </span>
      </label>

      <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
        실제 수능 문제지 판형(272×394mm, 2단)에 오답을 배치합니다. 정해진 개수는 반드시
        그 쪽에 들어가며, 남는 자리는 문제 사이에 고르게 나누고 모자라면 조금 줄여서
        넣습니다. 쪽번호와 아래쪽 전체 쪽수는 실제 쪽수에 맞춰 찍힙니다.
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
