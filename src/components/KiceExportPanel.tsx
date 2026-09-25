"use client";

import { useState } from "react";
import { buildKicePdf, LAYOUT, type KiceSpec } from "@/lib/kice/pdf";
import { passageSplitAt } from "@/lib/kice/passageSplit";
import {
  frameKeyFor,
  loadFrameImages,
  loadKiceFrames,
  type KiceArea,
} from "@/lib/kice/frames";
import { loadKiceFonts } from "@/lib/kice/fonts";
import { stripCardBorder } from "@/lib/kice/stripBorder";
import { KICE_AREAS, KICE_SUBJECTS } from "@/lib/kiceSubjects";
import { groupKoreanSets, type KoreanMeta } from "@/lib/koreanSet";
import type { KoreanPassage, KoreanSetIn } from "@/lib/kice/koreanLayout";

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
  // 국어는 지문과 문제를 펼침면에 나란히 놓는다(아래 `koreanPlan` 참고).
  { key: "korean", label: "국어 기본 (짝수 지문·홀수 문제)", pattern: [1] },
  { key: "tamgu", label: "탐구 기본 (4·6·6·4)", pattern: [4, 6, 6, 4] },
  // 한 쪽에 하나만. 왼쪽 단에 문제, 오른쪽 단은 통째로 풀이 공간이 된다.
  { key: "p1", label: "한 쪽에 1개", pattern: [1] },
  { key: "c1", label: "한 단에 1개", pattern: [2] },
  { key: "c2", label: "한 단에 2개", pattern: [4] },
  { key: "c3", label: "한 단에 3개", pattern: [6] },
  { key: "c4", label: "한 단에 4개", pattern: [8] },
] as const;

type LayoutKey = (typeof LAYOUTS)[number]["key"];

/**
 * 국어 본문 쪽의 단 높이(pt). 머리말 아래 가로줄(99.2)에서 본문 끝(962.63)
 * 까지에서 문제 사이 간격을 뺀 값이다 — `pdf.ts` 의 `frameBounds` 와 같은
 * 자리를 본다. 지문을 두 단에 나눌지 정하는 데 쓴다.
 */
const KOREAN_COLUMN_HEIGHT = 962.63 - 99.2 - LAYOUT.gap;

/**
 * 영역마다의 **기본 배치**(사용자가 정한 것).
 *
 * 과목마다 문제 길이가 달라서 하나로 맞출 수가 없다 — 수학은 한 문제가
 * 길어 쪽을 통째로 쓰고, 탐구·영어는 한 단에 하나가 맞고, 국어는 지문이
 * 따로 있어 아예 다른 규칙이 필요하다. 고를 수는 여전히 있다.
 */
const DEFAULT_LAYOUT: Record<KiceArea, LayoutKey> = {
  국어: "korean",
  수학: "p1",
  영어: "c1",
  사회탐구: "c1",
  과학탐구: "c1",
};

export type KiceItem = {
  id: string;
  imageUrl: string;
  label: string;
  answerLabel: string;
  answer: string;
  /** 내가 **잘못 쓴** 답. 틀렸을 때만 있다 — 정답표에 다른 색으로 찍는다. */
  picked?: string;
  /**
   * 출처(실모 이름). 국어 목차에 적고, **정답표를 출처별로 나누는** 데 쓴다
   * (실모를 둘 이상 묶어 뽑을 때).
   */
  source?: string;
  /** 국어 지문·문제 묶음. 국어 모드로 넣은 것에만 있다. */
  korean?: KoreanMeta | null;
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
  // 국어 세트로 넣은 문제가 있으면 국어로 뽑으려는 것이 분명하다.
  const hasKorean = items.some((it) => it.korean);
  const [area, setArea] = useState<KiceArea>(hasKorean ? "국어" : "사회탐구");
  const [subject, setSubject] = useState<string>(
    KICE_SUBJECTS[hasKorean ? "국어" : "사회탐구"][0] ?? "",
  );
  // 기본은 **표시하지 않음** — 실제 문제지에는 없는 글자다.
  const [showSource, setShowSource] = useState(false);
  /** 맨 뒤에 정답표를 붙일지. 오답프린트라 기본은 켜짐이다. */
  const [showAnswers, setShowAnswers] = useState(true);
  const [layoutKey, setLayoutKey] = useState<LayoutKey>(
    DEFAULT_LAYOUT[hasKorean ? "국어" : "사회탐구"],
  );
  /**
   * **탐구 배치를 손으로 고칠 수 있게 한다**(사용자 요청 — "4664말고 수동으로
   * 숫자 4개 써서 고를 수 있게"). 문자열로 들고 있는 이유는 지우고 새로
   * 입력하는 동안(빈 칸)에도 입력을 막지 않기 위해서다 — 숫자로 들고 있으면
   * 빈 칸이 0으로 튕겨 백스페이스가 뜻대로 안 된다. 실제 숫자는 쓸 때
   * `Number(...)`로 바꾼다(pdf.ts가 0 이하는 알아서 거른다).
   */
  const [tamguPattern, setTamguPattern] = useState<string[]>(
    (LAYOUTS.find((l) => l.key === "tamgu")?.pattern ?? [4, 6, 6, 4]).map(String),
  );
  const tamguSum = tamguPattern.reduce((sum, s) => sum + (Number(s) || 0), 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjects = KICE_SUBJECTS[area];

  function pickArea(next: KiceArea) {
    setArea(next);
    setSubject(KICE_SUBJECTS[next][0] ?? "");
    // 영역을 바꾸면 그 영역의 기본 배치로 따라간다 — 국어에서 탐구로 갔는데
    // 지문/문제 배치가 그대로 남아 있으면 첫 장이 통째로 목차가 된다.
    setLayoutKey(DEFAULT_LAYOUT[next]);
  }

  /**
   * 국어 세트를 모은다. **쪽은 여기서 짜지 않는다** — 지문이 한 단에 들어가는지
   * (그러면 문제를 옆 단에)는 글꼴과 그림 크기를 알아야 재는데 그건 `pdf.ts`
   * 에 있다(`planKoreanPages`). 목차 쪽번호도 거기서 함께 만든다.
   *
   * 지문 없는 문항(국어 모드를 안 거친 것)은 세트 뒤에 이어 붙인다. 지문
   * 쪽을 차지할 이유가 없어서 보통 배치처럼 한 쪽에 둘씩 넣는다.
   */
  async function buildKoreanSets(pngs: Uint8Array[]): Promise<NonNullable<KiceSpec["koreanSets"]>> {
    const index = new Map(items.map((it, i) => [it.id, i] as const));
    const { sets, loose } = groupKoreanSets(items, (it) => it.korean ?? null);

    const out: KoreanSetIn[] = [];
    for (const set of sets) {
      let passage: KoreanPassage | null = null;
      if (set.passage) {
        const at = index.get(set.passage.id)!;
        // **글자로 옮겨져 있으면 그걸로 조판한다** — 사진보다 또렷하고 단을
        // 따라 흐르고 평가원 서체와 맞는다(`pdf.ts`의 `passageText`). 옛
        // 데이터나 "원본 그대로 넣기"로 들어와 글자가 없으면(`blocks`가
        // 비어 있으면) 예전처럼 사진을 쓴다.
        const blocks = set.passage.korean?.blocks;
        if (blocks && blocks.length > 0) {
          passage = { kind: "text", blocks };
        } else {
          // 두 쪽짜리가 되면 두 단에 나눠 흘린다. 자를 자리는 줄과 줄 사이 빈
          // 띠에서 고른다(글자 줄이 반으로 잘리면 안 된다) — 그림을 여는 일이라
          // 브라우저에서 미리 잰다.
          const splitAt = await passageSplitAt(pngs[at], KOREAN_COLUMN_HEIGHT);
          passage = { kind: "image", index: at, ...(splitAt ? { splitAt } : {}) };
        }
      }
      out.push({
        passage,
        questions: set.questions.map((q) => index.get(q.id)!),
        title: set.title,
        source: set.passage?.source ?? set.questions[0]?.source ?? "",
      });
    }
    return { sets: out, loose: loose.map((q) => index.get(q.id)!) };
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
          // 지문에는 "N번" 표기를 붙이지 않는다 — 지문은 문제가 아니다.
          label:
            showSource && items[i].korean?.role !== "passage" ? items[i].label : "",
        })),
        pagePattern:
          layoutKey === "tamgu"
            ? tamguPattern.map((s) => Number(s) || 0)
            : [...(LAYOUTS.find((l) => l.key === layoutKey) ?? LAYOUTS[0]).pattern],
        koreanSets: layoutKey === "korean" ? await buildKoreanSets(pngs) : undefined,
        answers: showAnswers
          ? items.map((item) => ({
              label: item.answerLabel,
              answer: item.answer,
              picked: item.picked,
              // 실모를 둘 이상 묶어 뽑으면 정답표가 출처별로 갈린다 — 번호가
              // 실모마다 겹쳐서 한 덩어리로 붙여 놓으면 어느 시험지 답인지
              // 알 수 없다.
              source: item.source,
            }))
          : [],
        onWarn: (m) => console.warn("[kice]", m),
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
              {/* 탐구는 손으로 고친 값을 버튼 글자에도 그대로 보여준다 —
                  안 그러면 고쳐 놓고도 "4·6·6·4"라고 적힌 버튼만 보여 헷갈린다. */}
              {l.key === "tamgu" ? `탐구 기본 (${tamguPattern.join("·")})` : l.label}
            </button>
          ))}
        </div>

        {/* **탐구를 손으로 고친다**(사용자 요청). 실제 수능 탐구는 20문항을
            4쪽에 나눠 싣는데, 문제집마다 그 배분이 다를 수 있어 숫자 4개를
            직접 적게 한다. 합계를 옆에 보여 주되 20이 아니어도 막지는
            않는다 — 20문항이 아닌 세트(일부만 저장했거나 더 뽑은 경우)도
            있을 수 있어서다. */}
        {layoutKey === "tamgu" && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-xs text-slate-500">쪽마다 문제 수(1→4쪽):</span>
            {tamguPattern.map((value, i) => (
              <input
                key={i}
                type="text"
                inputMode="numeric"
                value={value}
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, "");
                  setTamguPattern((cur) => cur.map((v, idx) => (idx === i ? digits : v)));
                }}
                className="w-12 rounded border border-slate-300 px-2 py-1 text-center text-sm focus:border-blue-500 focus:outline-none"
              />
            ))}
            <span className={`text-xs ${tamguSum === 20 ? "text-emerald-600" : "text-amber-600"}`}>
              합 {tamguSum}
              {tamguSum !== 20 && " (보통 20)"}
            </span>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={showAnswers}
          onChange={(e) => setShowAnswers(e.target.checked)}
          className="h-4 w-4"
        />
        맨 뒤에 정답표 붙이기
        <span className="text-xs text-slate-400">
          정답을 적어 둔 문제만 표에 들어갑니다.
        </span>
      </label>

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
