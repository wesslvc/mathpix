"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

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

function title(row: GradeHistoryRow): string {
  const base = SUBJECT_LABEL[row.subject];
  const slot = row.subject === "elective" && row.elective_slot ? `${row.elective_slot}선택 · ` : "";
  return `${slot}${base}${row.elective_label ? ` · ${row.elective_label}` : ""}`;
}

function scoreText(row: GradeHistoryRow): string {
  if (row.score === null) return "점수 없음";
  return row.subject === "elective" ? `${row.score}/50점` : `${row.score}점`;
}

/**
 * 채점 기록 목록 + 검색.
 *
 * **이름을 검색해서 시행했던 실모와 점수를 찾을 수 있게 해달라**는 요청을
 * 여기서 처리한다 — 시험 이름(`exam_name`)·선택과목·과목명을 한 번에
 * 훑는다. 기록 수가 아주 많아지지 않는 한 서버 왕복 없이 브라우저에서
 * 바로 걸러도 충분하다.
 */
export default function GradeHistoryList({ rows }: { rows: GradeHistoryRow[] }) {
  const [query, setQuery] = useState("");

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

  return (
    <div className="flex flex-col gap-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="시험 이름·과목으로 검색 (예: 9월 모평, 생활과 윤리)"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
          {rows.length === 0 ? "아직 채점 기록이 없어요." : "검색 결과가 없어요."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((row) => (
            <li key={row.id}>
              <Link
                href={`/grades/${row.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-blue-300 hover:bg-blue-50"
              >
                <div className="min-w-0">
                  {row.exam_name && (
                    <p className="truncate text-xs text-slate-400">{row.exam_name}</p>
                  )}
                  <p className="truncate text-sm font-medium text-ink">{title(row)}</p>
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
          ))}
        </ul>
      )}
    </div>
  );
}
