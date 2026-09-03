"use client";

import { useState } from "react";
import Link from "next/link";
import { buildKicePdf } from "@/lib/kice/pdf";
import { frameKeyFor, loadFrameImages, loadKiceFrames, type KiceArea } from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import { ANSWER_SHEET_AREAS, KICE_SUBJECTS } from "@/lib/kiceSubjects";

/**
 * **정답표 생성기** — 손에 든 답지를 평가원 양식 정답표 한 쪽으로 뽑는다.
 *
 * 오답프린트 내보내기(`/export`)의 정답표는 그 실모에 저장된 문제의 정답을
 * 모아 만든다. 그런데 문제를 앱에 넣지 않고 **답지만** 양식대로 뽑고 싶은
 * 경우가 있다(직접 만든 시험지 뒤에 붙이는 것 등). 그래서 따로 뒀다.
 *
 * **이 화면이 앱 안에 있어야 하는 이유는 글꼴이다.** 정답표는 `(한)신중명조`
 * 로 그려지는데 그 글꼴은 배포권이 없어 저장소가 아니라 Supabase 비공개
 * 버킷에 있다. 로그인한 브라우저에서만 받을 수 있어서, 밖에서 만든 PDF 는
 * 서체가 다르다.
 *
 * **본문 쪽 틀에 그린다**(표지가 아니다). 쪽번호를 2 이상으로 주면
 * `buildKicePdf` 가 even/odd 틀을 쓴다 — 표지 틀은 제목 표와 성명 칸이 함께
 * 나와서 정답표 한 장으로는 어울리지 않는다. 덕분에 **영어도 된다**: 영어
 * 틀은 표지 교시 딱지가 제2교시 그대로라 문제지 내보내기에서는 못 쓰지만,
 * 본문 쪽에는 교시 딱지가 아예 없다(`kiceSubjects.ts` 주석 참고).
 */

/** 처음 열었을 때 보여줄 예시. 형식을 말로 설명하는 것보다 이게 빠르다. */
const SAMPLE = "5 ④\n17 ⑤\n23 ①\n27 ①\n37 ②\n38 ③\n39 ④";

/** 눌러서 넣을 수 있는 원숫자. 키보드로 치기 번거로운 글자다. */
const CIRCLED = ["①", "②", "③", "④", "⑤"];

export default function AnswerSheetPage() {
  const [area, setArea] = useState<KiceArea>("국어");
  const [subject, setSubject] = useState<string>("");
  const [pageNo, setPageNo] = useState("2");
  const [pageTotal, setPageTotal] = useState("2");
  const [text, setText] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const subjects = KICE_SUBJECTS[area];

  function pickArea(next: KiceArea) {
    setArea(next);
    setSubject(KICE_SUBJECTS[next][0] ?? "");
  }

  /**
   * "번호 정답" 을 줄마다 읽는다. 구분자는 공백·탭·쉼표 아무거나.
   *
   * 정답 쪽을 `slice(1).join(" ")` 로 다시 붙이는 것은 답이 여러 조각일 수
   * 있어서다(단답형 "2 3" 처럼). 번호만 적힌 줄은 버린다.
   */
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[\s,]+/);
      return { label: `${parts[0]}번`, answer: parts.slice(1).join(" ") };
    })
    .filter((r) => r.answer);

  async function make() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    const warns: string[] = [];
    try {
      const key = frameKeyFor(area);
      const [all, fonts] = await Promise.all([loadKiceFrames(), loadKiceFonts()]);
      const frames = all[key];
      const images = await loadFrameImages(frames);

      // 틀에 적힌 글자를 무엇으로 바꿀지. 공백을 뗀 글자로 찾는다.
      // 탐구는 틀 하나를 사회·과학이 같이 쓰므로 영역명과 과목명을 갈아끼운다.
      const replace: Record<string, string> = {};
      if (key === "tamgu") {
        replace["사회탐구영역"] = `${area} 영역`;
        replace["(사회문화)"] = subject ? `(${subject})` : "";
      }

      const no = Math.max(1, Number(pageNo) || 1);
      const bytes = await buildKicePdf({
        frames,
        replace,
        fonts,
        images,
        problems: [], // 문제 없이 정답표 쪽만
        pagePattern: [1],
        answers: rows,
        answerPage: { no, total: Math.max(no, Number(pageTotal) || no) },
        onWarn: (m) => warns.push(m),
      });
      setWarnings(warns);

      const blob = new Blob([bytes.slice().buffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const name = `${area}${subject ? ` ${subject}` : ""} 정답표`;
      link.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 px-4 py-10">
      <div>
        <Link href="/" className="text-sm text-slate-500 hover:text-ink">
          ← 실모 목록
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-ink">정답표 생성기</h1>
        <p className="mt-1 text-sm text-slate-500">
          답지를 평가원 양식 정답표 한 쪽으로 뽑습니다. 문제지 본문 쪽과 같은
          머리말·쪽번호가 들어가서 뒤에 붙이면 이어져 보입니다.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-700">영역</span>
        <div className="flex flex-wrap gap-1">
          {ANSWER_SHEET_AREAS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => pickArea(a)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                area === a
                  ? "border-blue-600 bg-blue-50 font-medium text-blue-700"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      {subjects.length > 0 && (
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          과목 (머리말 괄호 안에 찍힙니다)
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm text-slate-700">
          쪽번호
          <input
            type="number"
            min={1}
            value={pageNo}
            onChange={(e) => setPageNo(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-slate-700">
          전체 쪽수
          <input
            type="number"
            min={1}
            value={pageTotal}
            onChange={(e) => setPageTotal(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <p className="-mt-3 text-xs text-slate-400">
        쪽번호가 짝수면 번호가 왼쪽 위에, 홀수면 오른쪽 위에 찍힙니다(실제
        문제지와 같습니다). 1로 두면 표지 모양이 됩니다.
      </p>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        정답 (한 줄에 &quot;번호 정답&quot;)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          className="rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-sm"
        />
      </label>
      <div className="-mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-400">지금 {rows.length}개.</span>
        {CIRCLED.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setText((t) => t + c)}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            {c}
          </button>
        ))}
        <span className="text-xs text-slate-400">← 커서 대신 맨 뒤에 붙습니다</span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

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
