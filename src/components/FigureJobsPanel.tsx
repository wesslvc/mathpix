"use client";

import { useState } from "react";
import { useFigureJobs } from "./FigureJobsProvider";

const STATUS_TEXT = {
  pending: "차례 기다리는 중",
  running: "AI가 그리는 중",
  done: "완료",
  error: "실패",
} as const;

/**
 * 글자 인식(Mathpix)이 어떻게 됐는지 보여 주는 줄.
 *
 * 문제 전체를 그릴 때는 **Mathpix 가 읽은 글자를 프롬프트에 참고로 넣는다**
 * (그래야 이미지 생성 모델이 글자를 지어내지 않는다). 그 단계가 됐는지 안
 * 됐는지는 결과물의 글자 정확도를 좌우하므로 눈에 보여야 한다.
 */
function OcrLine({ ocr, preview }: { ocr?: string; preview?: string }) {
  if (!ocr) return null;
  if (ocr === "reading") {
    return (
      <p className="animate-soft-pulse text-[11px] text-slate-500">
        Mathpix로 글자 읽는 중…
      </p>
    );
  }
  if (ocr === "none") {
    return (
      <p className="text-[11px] text-amber-700">
        Mathpix 글자 참고 없음 — 그림만 보고 그립니다
      </p>
    );
  }
  return (
    <>
      <p className="text-[11px] text-emerald-700">Mathpix 글자 참고 ✓</p>
      {preview && (
        <p className="mt-0.5 truncate text-[10px] text-slate-400">
          “{preview}…”
        </p>
      )}
    </>
  );
}

/**
 * AI 그림 작업 현황을 화면 구석에 띄우는 패널.
 *
 * 작업이 도는 동안 사용자는 다음 문제로 넘어가 계속 작업한다. 그래서 진행
 * 상황은 문제 화면이 아니라 **화면 전체에 떠 있는 이 패널**에서 본다.
 * 작업이 하나도 없으면 아예 나타나지 않는다.
 */
export default function FigureJobsPanel() {
  const {
    jobs,
    activeCount,
    calls,
    spentUsd,
    spentKrw,
    krwRate,
    spentTokens,
    retry,
    dismiss,
  } = useFigureJobs();
  const [open, setOpen] = useState(false);

  if (jobs.length === 0) return null;

  const failed = jobs.filter((j) => j.status === "error").length;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[min(20rem,calc(100vw-2rem))]">
      <div className="animate-fade-in overflow-hidden rounded-xl border border-slate-300 bg-white shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        >
          {activeCount > 0 ? (
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
          ) : failed > 0 ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
          ) : (
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
            {activeCount > 0
              ? `AI가 ${activeCount}개를 그리는 중`
              : failed > 0
                ? `${failed}개 실패`
                : "AI 작업 완료"}
          </span>
          {/* 실제로 나간 유료 호출 수. 문제 수보다 많아지면(재시도가 쌓이면)
              그만큼 요금이 더 나간 것인데 지금까지 아무 단서가 없었다.
              캐시에 걸린 것은 세지 않는다 — 그건 돈이 안 나갔다. */}
          {calls > 0 && (
            <span className="shrink-0 text-[11px] text-slate-400">
              생성 {calls}회
              {/* 금액은 무제한 계정에만 온다(서버가 가린다). 일반 사용자에게는
                  토큰이 곧 비용이므로 그쪽을 보여준다. */}
              {spentUsd > 0
                ? ` · 약 ${spentKrw.toLocaleString()}원`
                : spentTokens > 0 && ` · ${spentTokens.toLocaleString()}토큰`}
            </span>
          )}
          <span className="shrink-0 text-[11px] text-slate-400">
            {open ? "닫기 ▾" : "보기 ▴"}
          </span>
        </button>

        {open && (
          <ul className="max-h-64 overflow-auto border-t border-slate-200">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-start gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-slate-700">
                    {j.label}
                  </p>
                  <p
                    className={`text-[11px] ${
                      j.status === "error"
                        ? "text-red-600"
                        : j.status === "done"
                          ? "text-emerald-700"
                          : "text-slate-500"
                    } ${j.status === "running" ? "animate-soft-pulse" : ""}`}
                  >
                    {STATUS_TEXT[j.status]}
                  </p>
                  <OcrLine ocr={j.ocr} preview={j.ocrPreview} />
                  {/* 어느 문제가 비쌌는지 보이게 한다. 캐시에 걸린 작업에는
                      값이 없다 — 그때는 돈이 안 나갔다. */}
                  {(typeof j.costUsd === "number" ||
                    typeof j.chargedTokens === "number") && (
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {typeof j.chargedTokens === "number" &&
                        `${j.chargedTokens}토큰`}
                      {typeof j.costUsd === "number" && (
                        <>
                          {typeof j.chargedTokens === "number" && " · "}약 $
                          {j.costUsd.toFixed(3)}
                          {typeof j.costKrw === "number" &&
                            ` (${j.costKrw.toLocaleString()}원)`}
                        </>
                      )}
                    </p>
                  )}
                  {j.error && (
                    <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
                      {j.error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {j.status === "error" && (
                    <button
                      type="button"
                      onClick={() => retry(j.id)}
                      className="rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100"
                    >
                      다시
                    </button>
                  )}
                  {(j.status === "done" || j.status === "error") && (
                    <button
                      type="button"
                      onClick={() => dismiss(j.id)}
                      className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
                    >
                      지우기
                    </button>
                  )}
                </div>
              </li>
            ))}
            {/* 이 금액은 청구서가 아니라 우리가 역산한 단가로 계산한 값이다.
                화면에서 분명히 해 두지 않으면 청구액으로 오해한다. */}
            {(spentUsd > 0 || spentTokens > 0) && (
              <li className="px-3 py-2 text-[10px] leading-snug text-slate-400">
                {spentUsd > 0 ? (
                  <>
                    합계 약 ${spentUsd.toFixed(2)} ({spentKrw.toLocaleString()}
                    원). 금액은 공표된 토큰 요금으로 계산한 값입니다
                    {krwRate &&
                      ` (원화는 1달러=${krwRate.toLocaleString()}원 기준)`}
                    . 최종 청구액은 OpenAI 대시보드를 보세요.
                  </>
                ) : (
                  <>
                    이번에 {spentTokens.toLocaleString()}토큰이 차감됐습니다. 쓴
                    만큼 정산되므로 문제마다 다를 수 있어요.
                  </>
                )}
              </li>
            )}
          </ul>
        )}

        {activeCount > 0 && (
          <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] leading-snug text-slate-400">
            그리는 동안 다음 문제를 계속 넣어도 됩니다. 완성되면 저장된 문제
            이미지가 자동으로 갱신돼요.
          </p>
        )}
      </div>
    </div>
  );
}
