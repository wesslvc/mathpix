import type { ExamScore } from "./supabase/types";
import { normalizeElectiveLabel } from "./examSubjects";

/** 과목별로 묶는 데 필요한 최소한의 필드. 채점 기록 목록(GradeHistoryRow)도
 * 같은 모양이라 그대로 받을 수 있다 — 묶는 기준을 두 곳에 따로 두면
 * 반드시 어긋난다. */
export type SubjectGroupable = Pick<
  ExamScore,
  "subject" | "elective_label" | "elective_slot"
>;

/** "지구과학1"처럼 옛 자유 입력 표기가 섞여 있어도 같은 과목이면 같은
 * 값으로 맞춘다(normalizeElectiveLabel 참고). */
function electiveLabelOf(row: SubjectGroupable): string | undefined {
  return row.elective_label ? normalizeElectiveLabel(row.elective_label) : undefined;
}

/** 과목(+탐구 과목명) 묶음 키. "elective:생활과 윤리"처럼 탐구는 과목명까지 갈라 묶는다. */
export function subjectGroupKey(row: SubjectGroupable): string {
  return row.subject === "elective"
    ? `elective:${electiveLabelOf(row) ?? row.elective_slot ?? "?"}`
    : row.subject;
}

/** 화면에 보여줄 과목 이름. */
export function subjectGroupLabel(row: SubjectGroupable): string {
  return row.subject === "korean"
    ? "국어"
    : row.subject === "math"
      ? "수학"
      : `탐구 · ${electiveLabelOf(row) ?? `${row.elective_slot ?? ""}선택`}`;
}

/** 국어 → 수학 → 탐구 순, 탐구는 과목명 가나다 순. */
export function compareSubjectGroups(
  a: { key: string; label: string },
  b: { key: string; label: string },
): number {
  const order = (k: string) => (k === "korean" ? 0 : k === "math" ? 1 : 2);
  return order(a.key) - order(b.key) || a.label.localeCompare(b.label, "ko");
}

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
    const key = subjectGroupKey(row);
    const label = subjectGroupLabel(row);

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

  return [...groups.values()].sort(compareSubjectGroups);
}
