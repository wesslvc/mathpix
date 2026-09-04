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
  mathpix: "running" | "ok" | "failed" | "skipped";
  terra: "pending" | "running" | "done" | "error";
  /**
   * 확대해서 보라고 함께 보낸 조각 수(`passageTiles.ts`). 0이면 통째로 한 장만
   * 보냈다는 뜻이다 — 짧은 지문이라 나눠도 이득이 없는 경우다. 이걸 보여 주는
   * 이유는 그림 생성의 `ocr` 표시와 같다: **글자 정확도를 좌우하는 단계인데
   * 조용히 넘어가면 왜 잘 읽혔는지/왜 틀렸는지 알 수 없다.**
   */
  tiles?: number;
  /** 일반 계정에 보여줄 토큰 수(terra 호출, 실사용량 정산). */
  chargedTokens?: number;
  /** 무제한 계정에만 보여줄 원화 추정치(막는 자리는 서버다). */
  costKrw?: number;
  errorMessage?: string;
};

const MATHPIX_LABEL: Record<PassageStatus["mathpix"], string> = {
  running: "글자 읽는 중…",
  ok: "참고 글 확보 ✓ (1토큰)",
  failed: "읽지 못함 — 사진만 보고 읽습니다",
  skipped: "건너뜀 — 사진만 보고 읽습니다",
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
          status.mathpix === "running"
            ? "animate-soft-pulse text-slate-500"
            : status.mathpix === "ok"
              ? "text-emerald-700"
              : "text-amber-700"
        }
      >
        Mathpix: {MATHPIX_LABEL[status.mathpix]}
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
        terra: {TERRA_LABEL[status.terra]}
        {status.tiles ? ` · 확대 ${status.tiles}조각으로 꼼꼼히 보는 중` : ""}
      </p>
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
