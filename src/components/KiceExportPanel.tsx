"use client";

import { useState } from "react";
import { buildKiceHwpx, frameFileFor, type KiceArea } from "@/lib/hwpx/frame";
import { KICE_AREAS, KICE_SUBJECTS } from "@/lib/kiceSubjects";

/**
 * 평가원 문제지 양식으로 내보내기.
 *
 * **PDF 가 아니라 한글 파일(.hwpx)로 내보내는 이유**는 글꼴이다. 수능 문제지는
 * 한컴 전용 글꼴(신명 견명조·중고딕, 한양 계열)로 짜여 있고, 이 글꼴들은 HFT
 * 형식이라 웹에 심을 수도, 서버에 담아 배포할 수도 없다. 우리가 글자를 직접
 * 그리면 어떤 방법을 써도 "비슷한 글꼴"이 된다.
 *
 * 그래서 글자는 한 자도 우리가 그리지 않는다. 원본 문제지의 틀을 그대로 두고
 * 제목만 갈아끼운 뒤 오답을 이미지로 얹어 hwpx 로 내보내고, PDF 로 뽑는 마지막
 * 한 걸음만 한글에서 한다("파일 > PDF로 저장하기"). 그 한 번의 손질로 글꼴이
 * 완전히 일치한다.
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

/** 이미지를 내려받아 픽셀 크기까지 알아낸다. hwpx 에 크기를 적어야 한다. */
async function loadImage(url: string): Promise<{ png: Uint8Array; widthPx: number; heightPx: number }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (HTTP ${res.status}).`);
  const buffer = await res.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([buffer]));
  const size = { widthPx: bitmap.width, heightPx: bitmap.height };
  bitmap.close();
  return { png: new Uint8Array(buffer), ...size };
}

export default function KiceExportPanel({ title, items }: Props) {
  const [area, setArea] = useState<KiceArea>("사회탐구");
  const [subject, setSubject] = useState<string>(KICE_SUBJECTS["사회탐구"][0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 문제지 아래 구석에 찍히는 "이 쪽 / 전체 쪽". 전체 쪽수는 한글이 실제로
   * 조판해 봐야 나오는 값이라 우리가 미리 알 수 없다. 원본 값(32쪽)이 그대로
   * 남으면 엉뚱하니 여기서 정하게 한다.
   */
  const [totalPages, setTotalPages] = useState(4);

  const subjects = KICE_SUBJECTS[area];

  function pickArea(next: KiceArea) {
    setArea(next);
    setSubject(KICE_SUBJECTS[next][0] ?? "");
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const frameRes = await fetch(`/kice/${frameFileFor(area)}.hwpx`, { cache: "force-cache" });
      if (!frameRes.ok) throw new Error("평가원 양식 틀을 불러오지 못했습니다.");
      const frame = await frameRes.arrayBuffer();

      const loaded = await Promise.all(items.map((item) => loadImage(item.imageUrl)));

      const blob = await buildKiceHwpx(frame, {
        title,
        area,
        subject,
        problems: items.map((item, i) => ({ label: item.label, ...loaded[i] })),
        answers: items.map((item) => ({ label: item.answerLabel, answer: item.answer })),
        totalPages,
      });

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const name = `${title || "오답모음"}${subject ? ` (${subject})` : ""}`;
      link.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}.hwpx`;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "한글 파일 만들기에 실패했습니다.");
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
        전체 쪽수
        <input
          type="number"
          min={1}
          max={99}
          value={totalPages}
          onChange={(e) => setTotalPages(Math.max(1, Number(e.target.value) || 1))}
          className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
        />
        <span className="text-xs text-slate-400">
          쪽 아래 &quot;쪽수 / 전체&quot; 표기에 쓰입니다. 한글에서 열어 실제 쪽수를 보고 고쳐도 됩니다.
        </span>
      </label>

      <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        수능 문제지의 글꼴은 한컴 전용 글꼴이라 웹에서는 똑같이 찍을 수 없습니다.
        그래서 <strong>한글 파일(.hwpx)</strong>로 내보냅니다. 받은 파일을 한글에서 열고{" "}
        <strong>파일 &gt; PDF로 저장하기</strong>를 누르면 글꼴까지 실제 문제지와 같은 PDF가
        됩니다.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={generate}
          disabled={busy || items.length === 0}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "한글 파일 만드는 중..." : "평가원 양식 한글 파일 만들기"}
        </button>
      </div>
    </div>
  );
}
