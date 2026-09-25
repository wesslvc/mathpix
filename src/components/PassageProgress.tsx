"use client";

/**
 * 지문을 글자로 옮기는 과정 표시.
 *
 * 그림 생성 큐(`FigureJobsPanel`)처럼 "지금 무슨 일이 도는지 이름으로 보여주고,
 * 끝나면 비용도 보여준다." 지문 인식은 큐를 타지 않는 별도 흐름
 * (`readPassageBlocks`/`reReadPassage`)이지만 같은 방식을 가져왔다.
 *
 * 2026-09-25부터 지문 인식은 **한 번의 호출**이다(글자와 모양을 함께 읽는다) —
 * 예전의 "1차 글자 읽기" 줄은 없어졌다.
 */
export type PassageStatus = {
  state: "running" | "done" | "error";
  /** 실제로 답한 모델 이름(서버가 응답에 실어 준다). 끝나기 전에는 모른다. */
  model?: string;
  /**
   * 서식 표시(굵게·밑줄·네모)를 제자리에 붙인 결과 요약(`describeMarks`).
   * 모델이 짚은 글을 본문에서 못 찾으면 그 표시는 버리는데, 밑줄은 문제가
   * 가리키는 자리라 빠졌는지가 눈에 보여야 한다.
   */
  marksNote?: string;
  /** 지문 안 그림을 붙인 진행·결과(`attachPassageFigures`). */
  figuresNote?: string;
  /** 일반 계정에 보여줄 차감 토큰. */
  chargedTokens?: number;
  /** 무제한 계정에만 보여줄 원화 추정치(막는 자리는 서버다). */
  costKrw?: number;
  errorMessage?: string;
};

const LABEL: Record<PassageStatus["state"], string> = {
  running: "글자·문단·강조를 함께 읽는 중…",
  done: "완료",
  error: "실패",
};

export function PassageProgress({
  status,
  unlimited,
}: {
  status: PassageStatus;
  unlimited: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      <p
        className={
          status.state === "running" && !status.figuresNote
            ? "animate-soft-pulse text-slate-500"
            : status.state === "error"
              ? "text-red-600"
              : "text-emerald-700"
        }
      >
        {status.model ?? "AI"}:{" "}
        {status.state === "running" && status.figuresNote ? "읽기 완료" : LABEL[status.state]}
      </p>
      {status.state !== "error" && status.marksNote ? (
        <p className="text-slate-500">{status.marksNote}</p>
      ) : null}
      {status.state !== "error" && status.figuresNote ? (
        <p
          className={
            status.state === "running" ? "animate-soft-pulse text-slate-500" : "text-slate-500"
          }
        >
          {status.figuresNote}
        </p>
      ) : null}
      {status.state === "done" &&
        (unlimited && typeof status.costKrw === "number" ? (
          <p className="text-slate-400">약 {status.costKrw.toLocaleString()}원</p>
        ) : typeof status.chargedTokens === "number" ? (
          <p className="text-slate-400">{status.chargedTokens.toLocaleString()}토큰</p>
        ) : null)}
      {status.state === "error" && status.errorMessage && (
        <p className="text-red-600">{status.errorMessage}</p>
      )}
    </div>
  );
}
