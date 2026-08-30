/**
 * 채점 결과의 **순수 계산**만 모아 둔 파일. 네트워크 호출도 환경변수도 없다 —
 * 서버(`gradeExam.ts`)뿐 아니라 검토 화면(브라우저)에서도 그대로 실어야
 * 하기 때문이다(`problemBoxes.ts`와 같은 이유).
 *
 * 서버가 처음 채점 결과를 만들 때와, 사용자가 검토 화면에서 학생답·정답을
 * 고친 뒤 다시 계산할 때 **같은 함수**를 쓴다 — 두 곳에서 따로 계산하면
 * 반드시 어긋난다.
 */

export type Subject = "korean" | "math" | "english" | "elective";

/** 채점 대상 문항 하나. */
export type GradedItem = {
  no: number;
  /** 학생이 마킹(또는 적은) 답. 못 읽었거나 무마킹/복수마킹이면 null. */
  studentAnswer: string | null;
  correctAnswer: string;
  /** 정답표에 배점이 있을 때만. 하나도 없으면 어떤 항목에도 없다. */
  points?: number;
};

/** 탐구 1선택/2선택처럼 한 번 채점에 슬롯이 여럿일 수 있다. */
export type GradeSlot = {
  slot?: 1 | 2;
  label?: string;
  items: GradedItem[];
};

/**
 * 이 과목의 원점수 만점. 국어·수학은 100점, 탐구는 과목당 50점 — 수능
 * 원점수 체계를 그대로 따른다. 배점을 다 못 읽었을 때 "틀린 문항만 골라
 * 배점 적기"의 기준점으로 쓰고(`deductionScore`), 점수를 보여줄 때도
 * 분모로 붙인다(`scoreLabel`) — 어느 쪽으로 얻은 점수든 만점은 같다.
 */
export function examMaxScore(subject: Subject): number {
  return subject === "elective" ? 50 : 100;
}

/**
 * 채점 결과를 요약한다. 배점이 하나라도 있으면 점수를 매기고, 하나도 없으면
 * `score`는 null이다(그때는 화면이 정답률과 틀린 번호로만 보여준다).
 */
export function computeSummary(items: GradedItem[]): {
  totalQuestions: number;
  correctCount: number;
  wrongNumbers: number[];
  score: number | null;
} {
  const norm = (v: string | null | undefined) =>
    (v ?? "").trim().replace(/\s+/g, "");
  const wrongNumbers: number[] = [];
  let correctCount = 0;
  let scoreSum = 0;
  const anyPoints = items.some((it) => typeof it.points === "number");

  for (const it of items) {
    const isCorrect =
      norm(it.studentAnswer) !== "" && norm(it.studentAnswer) === norm(it.correctAnswer);
    if (isCorrect) {
      correctCount++;
      if (typeof it.points === "number") scoreSum += it.points;
    } else {
      wrongNumbers.push(it.no);
    }
  }
  wrongNumbers.sort((a, b) => a - b);

  return {
    totalQuestions: items.length,
    correctCount,
    wrongNumbers,
    score: anyPoints ? scoreSum : null,
  };
}
