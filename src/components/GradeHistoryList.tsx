"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  compareSubjectGroups,
  subjectGroupKey,
  subjectGroupLabel,
} from "@/lib/scoreTrend";
import { normalizeElectiveLabel } from "@/lib/examSubjects";

export type GradeHistoryRow = {
  id: string;
  subject: "korean" | "math" | "elective";
  elective_slot: 1 | 2 | null;
  elective_label: string | null;
  exam_name: string | null;
  taken_at: string;
  score: number | null;
  grade_level: number | null;
  wrong_numbers: number[];
};

const SUBJECT_LABEL: Record<GradeHistoryRow["subject"], string> = {
  korean: "국어",
  math: "수학",
  elective: "탐구",
};

function subjectTitle(row: GradeHistoryRow): string {
  const base = SUBJECT_LABEL[row.subject];
  const slot = row.subject === "elective" && row.elective_slot ? `${row.elective_slot}선택 · ` : "";
  const label = row.elective_label ? normalizeElectiveLabel(row.elective_label) : null;
  return `${slot}${base}${label ? ` · ${label}` : ""}`;
}

/** 사용자가 붙인 이름이 있으면 그게 곧 제목이다 — 없으면 예전처럼
 * 과목명으로 대신한다. */
function primaryTitle(row: GradeHistoryRow): string {
  return row.exam_name?.trim() ? row.exam_name : subjectTitle(row);
}

/** 이름이 있을 때만 보여줄 작은 보조 줄(과목명). 이름이 없으면 그 자체가
 * 이미 제목이라 중복해서 또 보여줄 필요가 없다. */
function subjectSubline(row: GradeHistoryRow): string | null {
  return row.exam_name?.trim() ? subjectTitle(row) : null;
}

function scoreText(row: GradeHistoryRow): string {
  if (row.score === null) return "점수 없음";
  return row.subject === "elective" ? `${row.score}/50점` : `${row.score}점`;
}

type GroupMode = "all" | "date" | "subject";
const GROUP_LABEL: Record<GroupMode, string> = {
  all: "전체",
  date: "날짜별",
  subject: "과목별",
};

function Row({ row }: { row: GradeHistoryRow }) {
  return (
    <li>
      <Link
        href={`/grades/${row.id}`}
        className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-blue-300 hover:bg-blue-50"
      >
        <div className="min-w-0">
          {subjectSubline(row) && (
            <p className="truncate text-xs text-slate-400">{subjectSubline(row)}</p>
          )}
          <p className="truncate text-sm font-medium text-ink">{primaryTitle(row)}</p>
          <p className="text-xs text-slate-400">{row.taken_at}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-ink">{scoreText(row)}</p>
          <p className="text-xs text-slate-400">
            {row.grade_level ? `${row.grade_level}등급 · ` : ""}
            {row.wrong_numbers.length > 0
              ? `오답 ${row.wrong_numbers.length}개`
              : "전부 정답"}
          </p>
        </div>
      </Link>
    </li>
  );
}

/**
 * 채점 기록 목록 + 검색 + 묶어보기.
 *
 * **이름을 검색해서 시행했던 실모와 점수를 찾을 수 있게 해달라**는 요청을
 * 여기서 처리한다 — 시험 이름(`exam_name`)·선택과목·과목명을 한 번에
 * 훑는다. 기록 수가 아주 많아지지 않는 한 서버 왕복 없이 브라우저에서
 * 바로 걸러도 충분하다.
 *
 * **날짜별·과목별로 묶어 볼 수 있다.** 기록이 쌓이면 평평한 목록 하나로는
 * "그날 본 시험 전부"나 "이 과목만 쭉"을 한눈에 보기 어렵다. 과목 묶음
 * 기준은 추세 그래프(scoreTrend.ts)와 **같은 함수**를 쓴다 — 두 화면이
 * 각자 기준을 두면 반드시 어긋난다.
 *
 * 검색 중에는 묶음을 무시하고 평평한 목록으로 보여준다 — 폴더 화면과 같은
 * 이유다("이름은 아는데 어디 있는지 모를 때 찾기"에는 묶음이 방해가 된다).
 */
export default function GradeHistoryList({ rows }: { rows: GradeHistoryRow[] }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<GroupMode>("all");

  useEffect(() => {
    const saved = window.localStorage.getItem("grade-history-view");
    if (saved === "all" || saved === "date" || saved === "subject") setMode(saved);
  }, []);
  function pickMode(next: GroupMode) {
    setMode(next);
    window.localStorage.setItem("grade-history-view", next);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const haystack = [
        r.exam_name ?? "",
        r.elective_label ?? "",
        SUBJECT_LABEL[r.subject],
        r.taken_at,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, query]);

  const searching = query.trim() !== "";

  /** 날짜별: 최근 날짜부터. 같은 날 안에서는 과목 순서(국어→수학→탐구)로. */
  const byDate = useMemo(() => {
    if (searching || mode !== "date") return null;
    const groups = new Map<string, GradeHistoryRow[]>();
    for (const r of filtered) {
      const list = groups.get(r.taken_at) ?? [];
      list.push(r);
      groups.set(r.taken_at, list);
    }
    for (const list of groups.values()) {
      list.sort(
        (a, b) =>
          compareSubjectGroups(
            { key: subjectGroupKey(a), label: subjectGroupLabel(a) },
            { key: subjectGroupKey(b), label: subjectGroupLabel(b) },
          ),
      );
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered, mode, searching]);

  /** 과목별: 국어→수학→탐구(가나다) 순. 안에서는 최근 시행부터. */
  const bySubject = useMemo(() => {
    if (searching || mode !== "subject") return null;
    const groups = new Map<string, { label: string; rows: GradeHistoryRow[] }>();
    for (const r of filtered) {
      const key = subjectGroupKey(r);
      const g = groups.get(key) ?? { label: subjectGroupLabel(r), rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      g.rows.sort((a, b) => b.taken_at.localeCompare(a.taken_at));
    }
    return [...groups.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort(compareSubjectGroups);
  }, [filtered, mode, searching]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="시험 이름·과목으로 검색 (예: 9월 모평, 생활과 윤리)"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        {!searching && (
          <div className="flex shrink-0 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {(Object.keys(GROUP_LABEL) as GroupMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => pickMode(m)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  mode === m
                    ? "bg-white text-ink shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {GROUP_LABEL[m]}
              </button>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
          {rows.length === 0 ? "아직 채점 기록이 없어요." : "검색 결과가 없어요."}
        </p>
      ) : byDate ? (
        <div className="flex flex-col gap-4">
          {byDate.map(([date, list]) => (
            <div key={date} className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-slate-500">{date}</p>
              <ul className="flex flex-col gap-2">
                {list.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : bySubject ? (
        <div className="flex flex-col gap-4">
          {bySubject.map((g) => (
            <div key={g.key} className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-slate-500">{g.label}</p>
              <ul className="flex flex-col gap-2">
                {g.rows.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
