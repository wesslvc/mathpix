"use client";

import { useState } from "react";
import DiagramCropModal from "./DiagramCropModal";
import TokenGauge from "./TokenGauge";
import type { TokenStatus } from "@/app/api/tokens/route";

type Props = {
  /** 문제를 인식할 때 쓴 사진. null이면 카메라로 새로 찍어서만 쓸 수 있다. */
  imageSrc: string | null;
  status: TokenStatus | null;
  /** 아직 처리되지 않은 AI 작업 수(게이지에 곧 빠질 양을 보여주려고). */
  queuedCount: number;
  /**
   * 자리를 잡는다. 원본은 곧바로 카드에 붙고, useAi면 뒤에서 순서대로
   * AI가 다시 그려 그 자리를 채운다.
   */
  onAdd: (crop: string, useAi: boolean) => void;
};

/**
 * 그림(수학 도형 · 사과탐 자료)을 문제에 붙이는 패널.
 *
 * ── 왜 기다리지 않는가 ────────────────────────────────────────────────────
 * AI 그림 생성은 정확하지만 느리다(수십 초). 예전에는 한 장 만들 때마다 화면이
 * 멈춰 서서 기다려야 했다. 지금은 **자리를 먼저 잡는다** — 오려낸 원본이 곧바로
 * 카드에 붙고, AI는 뒤에서 순서대로 돌면서 완성되는 대로 그 자리를 갈아끼운다.
 * 그동안 사용자는 본문을 고치거나 다음 그림을 오려내면 된다.
 *
 * 이 방식의 부수 효과가 하나 더 있다: 처리가 끝나기 전에 저장해도 **원본이 든
 * 멀쩡한 이미지**가 저장된다. 빈 자리가 인쇄될 일이 없다.
 */
export default function FigurePanel({
  imageSrc,
  status,
  queuedCount,
  onAdd,
}: Props) {
  const [showCrop, setShowCrop] = useState(false);
  /** 오려낸 자료. 이게 있으면 "원본/AI" 선택 단계다. */
  const [pending, setPending] = useState<string | null>(null);

  const cost = status?.figureCost ?? 50;
  const canUseAi = status?.figureReady !== false;
  const unlimited = status?.unlimited ?? false;
  const tokens = status?.tokens ?? null;
  const notEnough = !unlimited && tokens !== null && tokens < cost;

  function choose(useAi: boolean) {
    if (!pending) return;
    onAdd(pending, useAi);
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">그림 넣기</p>
        <button
          type="button"
          onClick={() => setShowCrop(true)}
          className="g-btn g-btn-outline text-xs"
        >
          + 그림 추가
        </button>
      </div>

      <TokenGauge
        tokens={tokens}
        unlimited={unlimited}
        pending={queuedCount * cost}
      />

      <p className="text-[11px] text-slate-400">
        도형·자료 부분을 오려서 문제에 붙입니다. 원본을 그대로 붙이면 무료이고, AI로
        다시 그리면 {cost}토큰을 씁니다. Mathpix가 자동으로 잡아낸 그림은 이미
        원본 그대로 붙어 있으니, 그걸로 충분하면 따로 추가하지 않아도 됩니다.
      </p>

      {/* 오려내기가 끝나면 여기서 무료/유료를 고른다. 이 선택 단계가 곧
          "꼭 필요할 때만 AI를 쓴다"를 지키는 장치다. */}
      {pending && (
        <div className="flex animate-fade-in flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3">
          <div className="flex justify-center rounded bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pending}
              alt="오려낸 그림"
              className="max-h-48 w-auto object-contain"
            />
          </div>

          <p className="text-[11px] text-slate-600">이 그림을 어떻게 넣을까요?</p>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => choose(false)}
              className="g-btn g-btn-primary w-full text-xs"
            >
              원본 그대로 붙이기 (무료)
            </button>
            <p className="px-1 text-[11px] text-slate-500">
              사진, 현미경 사진, 지도처럼 색이 연속적으로 변하는 자료는 이쪽이
              정확합니다. 다시 그리면 원본에 있던 정보가 오히려 사라집니다.
            </p>

            <button
              type="button"
              onClick={() => choose(true)}
              disabled={!canUseAi || notEnough}
              className="g-btn g-btn-outline w-full text-xs"
            >
              AI로 깨끗하게 다시 그리기
              {unlimited ? " (무제한)" : ` (${cost}토큰)`}
            </button>
            <p className="px-1 text-[11px] text-slate-500">
              선과 글자로 된 도식·그래프·회로도라면 이쪽이 훨씬 깨끗하게
              인쇄됩니다. 누르면 자리부터 잡아두고 뒤에서 그리니 기다리지 않아도
              됩니다. 다만 AI가 한글 라벨을 잘못 쓰는 경우가 있으니 완성된 그림의
              글자는 꼭 확인해주세요.
              {status?.figureReady === false &&
                " (지금은 OPENAI_API_KEY가 설정되지 않아 쓸 수 없습니다.)"}
              {notEnough && ` (남은 ${tokens}토큰으로는 부족합니다.)`}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setPending(null)}
            className="g-btn g-btn-text self-start text-xs"
          >
            취소
          </button>
        </div>
      )}

      {showCrop && (
        <DiagramCropModal
          imageSrc={imageSrc}
          onConfirm={(cropped) => {
            setShowCrop(false);
            setPending(cropped);
          }}
          onCancel={() => setShowCrop(false)}
        />
      )}
    </div>
  );
}
