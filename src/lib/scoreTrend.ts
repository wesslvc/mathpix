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
      : row.subject === "english"
        ? "영어"
        : `탐구 · ${electiveLabelOf(row) ?? `${row.elective_slot ?? ""}선택`}`;
}

/** 국어 → 수학 → 영어 → 탐구 순, 탐구는 과목명 가나다 순. */
export function compareSubjectGroups(
  a: { key: string; label: string },
  b: { key: string; label: string },
): number {
  const order = (k: string) => (k === "korean" ? 0 : k === "math" ? 1 : k === "english" ? 2 : 3);
  return order(a.key) - order(b.key) || a.label.localeCompare(b.label, "ko");
}

export type TrendPoint = {
  takenAt: string;
  /**
   * 점수 보기: 배점이 있으면 점수, 없으면 정답률(%) — 0~100 한 축이다.
   * 등급 보기: 1~9 등급. 축이 뒤집힌다(1등급이 위) — 그리는 쪽 몫이다.
   */
  value: number;
  /** 배점이 있는 값인지 — 없으면(정답률로 대신한 값) 점을 다르게 그린다. */
  hasScore: boolean;
  wrongCount: number;
};

/**
 * 추세를 무엇으로 볼지.
 *
 * 점수는 과목마다 만점이 달라(국·수·영 100, 탐구 50) 과목끼리 견주기
 * 어렵지만, **등급은 과목이 달라도 같은 1~9 척도**라 한 화면에서 바로
 * 비교된다. 대신 등급은 사용자가 직접 적어 넣는 값이라(등급컷은 해마다
 * 달라 계산할 수 없다) 안 적은 시험은 그래프에 점이 없다.
 */
export type TrendMetric = "score" | "grade";

export type TrendSeries = {
  key: string;
  /** 화면에 보여줄 이름. 탐구는 "탐구 · 생활과 윤리"처럼 과목명을 붙인다. */
  label: string;
  points: TrendPoint[];
};

/** 과목(+ 탐구 과목명)별로 나눠 시간순 추세를 만든다. */
export function buildTrendSeries(
  rows: ExamScore[],
  metric: TrendMetric = "score",
): TrendSeries[] {
  const groups = new Map<string, TrendSeries>();

  for (const row of rows) {
    // 등급은 적어 둔 시험에만 있다 — 없는 것을 0 같은 값으로 채우면
    // 그래프가 바닥을 찍어 실제로 등급이 떨어진 것처럼 보인다. 아예 뺀다.
    if (metric === "grade" && row.grade_level == null) continue;

    const key = subjectGroupKey(row);
    const label = subjectGroupLabel(row);

    const value =
      metric === "grade"
        ? (row.grade_level as number)
        : (row.score ??
          (row.total_questions > 0
            ? Math.round((row.correct_count / row.total_questions) * 100)
            : 0));

    const series = groups.get(key) ?? { key, label, points: [] };
    series.points.push({
      takenAt: row.taken_at,
      value,
      // 등급은 "배점이 있어 얻은 값"이라는 구분 자체가 없다 — 전부 채운 점.
      hasScore: metric === "grade" ? true : row.score !== null,
      wrongCount: row.wrong_numbers.length,
    });
    groups.set(key, series);
  }

  for (const series of groups.values()) {
    series.points.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  }

  return [...groups.values()].sort(compareSubjectGroups);
}
