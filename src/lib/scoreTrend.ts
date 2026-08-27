import type { ExamScore } from "./supabase/types";

export type TrendPoint = {
  takenAt: string;
  /** 배점이 있으면 점수, 없으면 정답률(%). 그래프는 항상 0~100 하나의 축으로 그린다. */
  value: number;
  /** 배점이 있는 값인지 — 없으면(정답률로 대신한 값) 점을 다르게 그린다. */
  hasScore: boolean;
  wrongCount: number;
};

export type TrendSeries = {
  key: string;
  /** 화면에 보여줄 이름. 탐구는 "탐구 · 생활과 윤리"처럼 과목명을 붙인다. */
  label: string;
  points: TrendPoint[];
};

/** 과목(+ 탐구 과목명)별로 나눠 시간순 추세를 만든다. */
export function buildTrendSeries(rows: ExamScore[]): TrendSeries[] {
  const groups = new Map<string, TrendSeries>();

  for (const row of rows) {
    const key =
      row.subject === "elective"
        ? `elective:${row.elective_label ?? row.elective_slot ?? "?"}`
        : row.subject;
    const label =
      row.subject === "korean"
        ? "국어"
        : row.subject === "math"
          ? "수학"
          : `탐구 · ${row.elective_label ?? `${row.elective_slot ?? ""}선택`}`;

    const value =
      row.score ?? Math.round((row.correct_count / row.total_questions) * 100);

    const series = groups.get(key) ?? { key, label, points: [] };
    series.points.push({
      takenAt: row.taken_at,
      value,
      hasScore: row.score !== null,
      wrongCount: row.wrong_numbers.length,
    });
    groups.set(key, series);
  }

  for (const series of groups.values()) {
    series.points.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  }

  // 국어 → 수학 → 탐구 순, 탐구는 과목명 알파벳(가나다) 순.
  const order = (k: string) => (k === "korean" ? 0 : k === "math" ? 1 : 2);
  return [...groups.values()].sort(
    (a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label, "ko"),
  );
}
