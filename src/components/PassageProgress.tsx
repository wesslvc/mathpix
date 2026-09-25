"use client";

/**
 * 지문을 글자로 옮기는 과정 표시.
 *
 * 그림 생성 큐(`FigureJobsPanel`)는 "지금 무슨 일이 도는지 이름으로 보여주고
 * (Mathpix 글자 참고 ✓ 처럼), 끝나면 비용도 보여준다." 지문 인식은 큐를 타지
 * 않는 별도 흐름(`readPassageBlocks`/`reReadPassage`)이지만, 사용자가 "이것도
 * 초 단위로 말고 Mathpix/terra 라고 구체적으로, 비용도 보여달라"고 요청해서
 * 같은 방식을 그대로 가져왔다.
 */
export type PassageStatus = {
  /**
   * 1차 글자 읽기(GPT, 예전 Mathpix 자리). 글자만 한 자씩 옮겨 적는 단계다 —
   * 그 글이 다음 단계(모양 읽기)의 참고 글이 되고, 끝나면 글자를 그걸로 맞춘다.
   */
  reader: "running" | "ok" | "failed" | "skipped";
  /** 1차 읽기를 한 모델(서버가 응답에 실어 준다). */
  readerModel?: string;
  /** 1차 읽기 비용(무제한 계정은 원, 일반 계정은 토큰). */
  readerCostKrw?: number;
  readerTokens?: number;
  terra: "pending" | "running" | "done" | "error";
  /**
   * 1차 읽기 기준으로 갈아 끼운 원문자 수(`alignCircledToReference`).
   * **보여 주는 이유**: 원문자 하나가 바뀌면 문제가 성립하지 않는 자리라,
   * 우리가 고쳤는지 안 고쳤는지가 눈에 보여야 한다.
   */
  circledFixed?: number;
  /** 원문자 개수가 참고 글과 달라 손대지 못했다(짝지을 근거가 없다). */
  circledMismatch?: boolean;
  /** 글자를 1차 읽기 것으로 갈아 끼운 결과 요약(`describeMerge`). */
  lettersNote?: string;
  /**
   * 실제로 답한 모델 이름(서버가 응답에 실어 준다).
   *
   * 지문 인식은 **Gemini Flash 를 먼저 쓰고 안 되면 terra 로 내려간다** —
   * 그래서 "terra" 라고 못박아 두면 거짓말이 된다. 갈아탔는지 여부가 값과
   * 정확도를 좌우하므로 눈에 보여야 한다(어느 모델이 잡았는지 화면에도
   * 찍는다는 이 저장소의 규칙과 같다). 끝나기 전에는 어느 쪽이 답할지 모른다.
   */
  model?: string;
  /** 일반 계정에 보여줄 토큰 수(실사용량 정산). */
  chargedTokens?: number;
  /** 무제한 계정에만 보여줄 원화 추정치(막는 자리는 서버다). */
  costKrw?: number;
  errorMessage?: string;
};

const READER_LABEL: Record<PassageStatus["reader"], string> = {
  running: "글자만 한 자씩 옮겨 적는 중…",
  ok: "글자 확보 ✓",
  failed: "읽지 못함 — 모양 읽기만으로 진행합니다",
  skipped: "건너뜀 — 모양 읽기만으로 진행합니다",
};

const TERRA_LABEL: Record<PassageStatus["terra"], string> = {
  pending: "대기 중",
  running: "문단·상자·강조 구조 분석 중…",
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
          status.reader === "running"
            ? "animate-soft-pulse text-slate-500"
            : status.reader === "ok"
              ? "text-emerald-700"
              : "text-amber-700"
        }
      >
        1차 글자 읽기{status.readerModel ? ` (${status.readerModel})` : ""}:{" "}
        {READER_LABEL[status.reader]}
        {status.reader === "ok" && unlimited && typeof status.readerCostKrw === "number"
          ? ` · 약 ${status.readerCostKrw.toLocaleString(undefined, { maximumFractionDigits: 1 })}원`
          : status.reader === "ok" && typeof status.readerTokens === "number"
            ? ` · ${status.readerTokens.toLocaleString()}토큰`
            : ""}
      </p>
      <p
        className={
          status.terra === "running"
            ? "animate-soft-pulse text-slate-500"
            : status.terra === "done"
              ? "text-emerald-700"
              : status.terra === "error"
                ? "text-red-600"
                : "text-slate-400"
        }
      >
        {status.model ?? "AI"}: {TERRA_LABEL[status.terra]}
        {status.terra === "done" && status.circledFixed
          ? ` · 원문자 ${status.circledFixed}자를 1차 읽기 기준으로 교정`
          : ""}
        {status.terra === "done" && status.circledMismatch
          ? " · 원문자 개수가 참고 글과 달라 그대로 뒀어요(확인해 주세요)"
          : ""}
      </p>
      {status.terra === "done" && status.lettersNote ? (
        <p className="text-slate-500">{status.lettersNote}</p>
      ) : null}
      {status.terra === "done" &&
        (unlimited && typeof status.costKrw === "number" ? (
          <p className="text-slate-400">약 {status.costKrw.toLocaleString()}원</p>
        ) : typeof status.chargedTokens === "number" ? (
          <p className="text-slate-400">{status.chargedTokens.toLocaleString()}토큰</p>
        ) : null)}
      {status.terra === "error" && status.errorMessage && (
        <p className="text-red-600">{status.errorMessage}</p>
      )}
    </div>
  );
}
