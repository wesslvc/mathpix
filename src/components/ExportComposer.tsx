"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { KoreanMeta } from "@/lib/koreanSet";

/**
 * 내보내기 — 제목·인쇄 순서를 정하고 **평가원 문제지 양식**으로 뽑는다.
 *
 * **일반 A4 양식은 없앴다**(사용자 결정). 평가원 판형이 실제 시험지와 같아
 * 풀이 감각이 맞고, 두 양식을 함께 유지하면 정답표·라벨·배치 규칙을 두 벌
 * 관리해야 해서 반드시 한쪽이 뒤처진다. 실제로 "내가 고른 답 찍기" 같은
 * 기능은 두 곳에 같은 함수를 억지로 끼워 맞춰 두고 있었다.
 * (A4 로 그리던 코드가 필요하면 git 이력에서 찾을 것.)
 */
const KiceExportPanel = dynamic(() => import("./KiceExportPanel"), {
  ssr: false,
  loading: () => <p className="text-sm text-slate-500">평가원 양식 준비 중...</p>,
});

export type ComposerProblem = {
  id: string;
  imageUrl: string;
  /** 점수까지 붙은 출처 표기(예: "강대2회(96/100)"). */
  source: string;
  /** 점수를 뺀 출처(예: "강대2회"). 같은 출처가 반복될 때 쓴다. */
  sourceBase: string;
  origNumber: number | null;
  /** 사용자가 손으로 정해 둔 번호. 있으면 무조건 이걸 쓴다. */
  manualNumber: number | null;
  answer: string;
  /**
   * 채점 기록이 연동된 문제에서 **내가 고른 답**. 틀린 문제면 이게 곧
   * "왜 틀렸는지"라, 정답표에 정답과 나란히 찍어 주면 다시 풀 때
   * 무엇을 잘못 골랐는지 바로 보인다. 연동이 없으면 undefined.
   */
  studentAnswer?: string;
  /** 국어 지문·문제 묶음 정보. 국어 모드로 넣은 것에만 있다. */
  korean?: KoreanMeta | null;
};

/**
 * 정답과 **내가 잘못 쓴 답**을 갈라서 돌려준다.
 *
 * 왜 나눠 두나: PDF 정답표에서 **틀린 답만 다른 색으로** 찍으려면 두 토막이
 * 따로 있어야 한다(사용자 요청). 한 문자열로 합쳐 버리면 어디까지가 정답이고
 * 어디부터가 내 답인지 그리는 쪽에서 다시 갈라야 하는데, 정답에 괄호가 들어간
 * 단답형이 있어서 글자로 되짚는 방식은 안전하지 않다.
 *
 * `picked` 는 **틀렸을 때만** 채운다 — 맞힌 문제는 굳이 두 번 적지 않는다.
 * 정답이 비어 있으면(정답을 안 적어 둔 문제) 정답표에서 빠지는 게 기존
 * 동작이라, 내 답만 있다고 새로 끼워 넣지는 않는다.
 */
export function answerParts(
  problem: Pick<ComposerProblem, "answer" | "studentAnswer">,
  showPicked: boolean,
): { answer: string; picked: string } {
  const answer = (problem.answer ?? "").trim();
  const picked = (problem.studentAnswer ?? "").trim();
  if (!answer) return { answer: "", picked: "" };
  if (!showPicked || !picked || picked === answer) return { answer, picked: "" };
  return { answer, picked };
}

type Props = {
  multi: boolean;
  defaultTitle: string;
  examDate: string;
  problems: ComposerProblem[];
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${y}. ${Number(m)}. ${Number(d)}.`;
}

export default function ExportComposer({
  multi,
  defaultTitle,
  examDate,
  problems,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [order, setOrder] = useState<ComposerProblem[]>(problems);
  /**
   * 정답표에 **내가 고른 답**도 같이 찍을지. 채점이 연동된 문제가 하나라도
   * 있을 때만 뜻이 있으므로 그때만 보여준다(기본 켜짐 — 오답프린트라
   * 무엇을 잘못 골랐는지가 핵심이다).
   */
  const [showPicked, setShowPicked] = useState(true);
  const hasPicked = problems.some((p) => (p.studentAnswer ?? "").trim() !== "");

  /**
   * **여러 실모를 묶어 뽑을 때 실모 차례를 바꾼다**(사용자 요청).
   *
   * 기본은 **오래된 것부터**다(서버가 시행일로 줄을 세워 보낸다). 문제 하나씩
   * 옮기는 것만으로는 회차를 통째로 앞뒤로 보내기가 번거롭다 — 20문제짜리
   * 실모를 앞으로 보내려면 스무 번을 옮겨야 한다.
   *
   * 실모 차례를 바꾸면 그 실모의 문제들이 **덩어리째** 따라 움직인다.
   * 실모 안의 차례(문제 번호 순)는 그대로다.
   */
  const sourceOrder = useMemo(() => {
    const seen: string[] = [];
    for (const p of problems) {
      if (!seen.includes(p.sourceBase)) seen.push(p.sourceBase);
    }
    return seen;
  }, [problems]);
  const [sources, setSources] = useState<string[]>(sourceOrder);

  function moveSource(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= sources.length) return;
    const next = [...sources];
    [next[index], next[j]] = [next[j], next[index]];
    setSources(next);
    // 문제 목록도 그 차례로 다시 늘어놓는다(실모 안의 차례는 유지).
    setOrder((cur) =>
      [...cur].sort((a, b) => {
        const ia = next.indexOf(a.sourceBase);
        const ib = next.indexOf(b.sourceBase);
        if (ia !== ib) return ia - ib;
        return cur.indexOf(a) - cur.indexOf(b);
      }),
    );
  }

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    setOrder(next);
  }

  /**
   * 문제에 찍을 번호.
   *
   * 손으로 정해 둔 값이 있으면 **무엇보다 우선**한다 — 실제 시험지 번호를
   * 그대로 쓰고 싶을 때가 있다(15·22·28처럼 띄엄띄엄). 없으면 예전대로:
   * 여러 묶음을 한 번에 뽑을 때는 차례대로, 한 묶음이면 본문에서 뽑은 번호.
   */
  function numberFor(problem: ComposerProblem, index: number): number {
    if (problem.manualNumber != null) return problem.manualNumber;
    return multi ? index + 1 : (problem.origNumber ?? index + 1);
  }

  /**
   * 각 문제 라벨.
   *
   * 같은 내용을 페이지마다 반복하지 않는 것이 원칙이다.
   * - 단일 묶음: 출처와 점수가 이미 첫 페이지 제목에 있으므로 번호만 적는다.
   * - 여러 묶음: 출처는 문제마다 다를 수 있으니 남기되, 점수는 그 출처가 처음
   *   나오는 페이지에서 한 번만 적는다.
   */
  function labelFor(problem: ComposerProblem, index: number): string {
    const n = numberFor(problem, index);
    if (!multi) return `${n}번`;

    const firstOfSource =
      order.findIndex((p) => p.sourceBase === problem.sourceBase) === index;
    return `${firstOfSource ? problem.source : problem.sourceBase} ${n}번`;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          제목
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={multi ? "제목을 입력하세요 (예: 미적분 오답 모음)" : "제목"}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <p className="text-xs text-slate-400">
          시행일 : {formatDate(examDate)} (실모 추가 시 정한 날짜)
        </p>
      </div>

      {sources.length > 1 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-700">
            실모 순서 ({sources.length}개)
          </h2>
          <p className="text-xs text-slate-400">
            기본은 오래된 것부터입니다. 옮기면 그 실모의 문제가 덩어리째 따라
            움직여요.
          </p>
          <ol className="flex flex-col gap-1.5">
            {sources.map((name, index) => (
              <li
                key={name}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <span className="w-5 shrink-0 text-center text-xs text-slate-400">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {name}
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  {order.filter((p) => p.sourceBase === name).length}문제
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveSource(index, -1)}
                    disabled={index === 0}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSource(index, 1)}
                    disabled={index === sources.length - 1}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  >
                    ↓
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">
            인쇄 순서 ({order.length}문제)
          </h2>
          <span className="text-xs text-slate-400">
            순서를 바꾸지 않으면 추가한 순서대로 인쇄됩니다.
          </span>
        </div>

        <ol className="flex flex-col gap-2">
          {order.map((problem, index) => (
            <li
              key={problem.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2"
            >
              <span className="w-6 shrink-0 text-center text-sm font-medium text-slate-500">
                {index + 1}
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={problem.imageUrl}
                alt="오답"
                className="h-16 w-16 shrink-0 rounded border border-slate-200 object-contain"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                {problem.korean?.role === "passage" && (
                  <span className="mr-1 rounded bg-emerald-100 px-1 text-xs text-emerald-700">
                    지문
                  </span>
                )}
                {labelFor(problem, index)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === order.length - 1}
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  ↓
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* 채점이 연동된 문제가 있을 때만 뜻이 있다. */}
      {hasPicked && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={showPicked}
            onChange={(e) => setShowPicked(e.target.checked)}
          />
          정답표에 내가 고른 답도 같이 찍기 (예: ④ (내답 ②))
        </label>
      )}

      <KiceExportPanel
        title={title}
        items={order.map((problem, index) => ({
          id: problem.id,
          imageUrl: problem.imageUrl,
          label: labelFor(problem, index),
          answerLabel: `${numberFor(problem, index)}번`,
          // 정답과 내가 틀린 답을 **갈라서** 넘긴다 — 정답표에서 틀린 답만
          // 다른 색으로 찍기 위해서다.
          ...answerParts(problem, showPicked),
          source: problem.sourceBase,
          korean: problem.korean ?? null,
        }))}
      />
    </div>
  );
}
