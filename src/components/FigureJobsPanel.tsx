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
 * AI 그림 작업 현황을 화면 구석에 띄우는 패널.
 *
 * 작업이 도는 동안 사용자는 다음 문제로 넘어가 계속 작업한다. 그래서 진행
 * 상황은 문제 화면이 아니라 **화면 전체에 떠 있는 이 패널**에서 본다.
 * 작업이 하나도 없으면 아예 나타나지 않는다.
 */
export default function FigureJobsPanel() {
  const { jobs, activeCount, retry, dismiss } = useFigureJobs();
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
