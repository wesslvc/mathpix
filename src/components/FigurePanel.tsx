"use client";

import { useEffect, useState } from "react";
import DiagramCropModal from "./DiagramCropModal";
import { prepareFigureForModel, rasterToSvg } from "@/lib/figureImage";
import {
  figureCacheKey,
  readFigureCache,
  writeFigureCache,
} from "@/lib/figureCache";
import type { FigureConfig } from "@/app/api/figure/config/route";

type Props = {
  /** 문제를 인식할 때 쓴 사진. null이면 카메라로 새로 찍어서만 쓸 수 있다. */
  imageSrc: string | null;
  /** 남은 사진인식권. 모르면 null. */
  credits: number | null;
  unlimited: boolean;
  /** 완성된 자료(SVG 문자열)를 문제 카드에 붙인다. */
  onAdd: (svg: string) => void;
  /** 크레딧을 썼으니 잔량을 다시 읽어달라. */
  onCreditsUsed: () => void;
};

/** 진행률은 알 수 없으니 경과 시간으로 "멈춘 게 아니다"를 보여준다. */
const EXPECTED_SEC = 35;

function statusText(sec: number): string {
  if (sec < 4) return "자료를 서버로 보내는 중...";
  if (sec < 12) return "자료를 읽고 있어요...";
  if (sec < 25) return "벡터 그림으로 다시 그리는 중이에요...";
  return "거의 다 됐어요. 자료가 복잡하면 조금 더 걸립니다...";
}

/**
 * 사회탐구·과학탐구 자료(실험 장치도, 모식도, 그래프, 표, 단면도)를 문제에
 * 붙이는 패널.
 *
 * 수학 도형(Gemini)과 완전히 따로 돈다. 두 기능이 결과만 같은 모양(SVG 문자열)
 * 이라 문제 카드에 붙고 저장되는 경로는 공유하지만, 그 앞단은 전혀 다르다.
 *
 * ── 비용에 대한 설계 ──────────────────────────────────────────────────────
 * 이 기능은 호출할 때마다 실제로 요금이 나가는 API를 쓴다. 그래서 자료를
 * 오려낸 다음 곧바로 보내지 않고, **원본 그대로 붙이기(무료)** 와
 * **AI로 다시 그리기(유료)** 중에 사용자가 고르게 한다. 무료 쪽을 기본으로
 * 앞에 두었다 — 사진·현미경 사진·지도처럼 다시 그리면 오히려 정보가 사라지는
 * 자료가 사과탐에는 아주 많고, 그런 자료는 원본이 정답이기 때문이다.
 *
 * 어느 쪽인지 픽셀 통계로 자동 판별하려고도 해봤지만 신뢰할 수 없어서 뺐다
 * (이유는 figureImage.ts 주석 참고). 사람이 보면 1초면 아는 것을 굳이 틀리게
 * 자동화하느니 물어보는 편이 낫다.
 */
export default function FigurePanel({
  imageSrc,
  credits,
  unlimited,
  onAdd,
  onCreditsUsed,
}: Props) {
  const [config, setConfig] = useState<FigureConfig | null>(null);
  const [showCrop, setShowCrop] = useState(false);
  /** 오려낸 자료. 이게 있으면 "원본/재구성" 선택 단계다. */
  const [pending, setPending] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/figure/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setConfig(data as FigureConfig);
      })
      .catch(() => {
        // 설정을 못 읽어도 원본 붙이기는 되어야 하므로 패널 자체는 남긴다.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isWorking) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isWorking]);

  const cost = config?.cost ?? 5;
  const canReconstruct = config?.configured !== false;
  const notEnough =
    !unlimited && credits !== null && credits < cost;

  /** 무료 경로: 오려낸 원본을 그대로 문제에 붙인다. LLM을 부르지 않는다. */
  async function useOriginal() {
    if (!pending) return;
    setError(null);
    try {
      onAdd(await rasterToSvg(pending));
      setPending(null);
      setNotice("원본 자료를 그대로 붙였어요. (크레딧 차감 없음)");
    } catch (err) {
      setError(err instanceof Error ? err.message : "자료를 붙이지 못했습니다.");
    }
  }

  /** 유료 경로: 줄인 이미지를 서버로 보내 SVG로 다시 그린다. */
  async function reconstruct() {
    if (!pending) return;
    setIsWorking(true);
    setError(null);
    setNotice(null);
    try {
      // 입력 토큰을 줄이려고 긴 변을 768px로 낮춰 보낸다.
      const forModel = await prepareFigureForModel(pending);

      // 같은 자료를 이미 그린 적이 있으면 그대로 쓴다. 사과탐은 자료 하나에
      // 문항이 여러 개 딸린 세트가 흔해서 이 경우가 실제로 자주 나온다.
      const key = await figureCacheKey(forModel);
      const cached = readFigureCache(key);
      if (cached) {
        onAdd(cached);
        setPending(null);
        setNotice("같은 자료를 이미 그린 적이 있어 그 결과를 다시 썼어요. (차감 없음)");
        return;
      }

      const res = await fetch("/api/figure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: forModel }),
      });

      let json: { svg?: string; error?: string };
      try {
        json = await res.json();
      } catch {
        // 실행시간 초과 등으로 Vercel이 JSON이 아닌 에러 페이지를 돌려준 경우.
        throw new Error(
          "서버에서 정상적인 응답을 받지 못했어요. 자료가 복잡해 시간이 오래 걸렸을 수 있습니다. 영역을 더 좁게 잘라 다시 시도하거나, 원본을 그대로 붙여주세요.",
        );
      }
      if (!res.ok) throw new Error(json.error ?? "자료 재구성에 실패했습니다.");

      const svg = json.svg as string;
      writeFigureCache(key, svg);
      onAdd(svg);
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "자료 재구성에 실패했습니다.");
    } finally {
      setIsWorking(false);
      onCreditsUsed();
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">
          사회탐구 · 과학탐구 자료
        </p>
        <button
          type="button"
          onClick={() => {
            setShowCrop(true);
            setError(null);
            setNotice(null);
          }}
          disabled={isWorking}
          className="g-btn g-btn-outline text-xs"
        >
          자료 추가
        </button>
      </div>

      <p className="text-[11px] text-slate-400">
        실험 장치, 모식도, 그래프, 표, 지층 단면 같은 자료를 오려서 문제에
        붙입니다. 원본을 그대로 붙이면 무료이고, AI로 다시 그리면 사진인식권
        {" "}
        {cost}장을 씁니다.
      </p>

      {/* 오려내기가 끝나면 여기서 무료/유료를 고른다. 이 선택 단계가 곧
          "꼭 필요할 때만 LLM을 쓴다"를 지키는 장치다. */}
      {pending && !isWorking && (
        <div className="flex flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3">
          <div className="flex justify-center rounded bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pending}
              alt="오려낸 자료"
              className="max-h-48 w-auto object-contain"
            />
          </div>

          <p className="text-[11px] text-slate-600">
            이 자료를 어떻게 넣을까요?
          </p>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void useOriginal()}
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
              onClick={() => void reconstruct()}
              disabled={!canReconstruct || notEnough}
              className="g-btn g-btn-outline w-full text-xs"
            >
              AI로 깨끗하게 다시 그리기
              {unlimited ? " (무제한)" : ` (사진인식권 ${cost}장)`}
            </button>
            <p className="px-1 text-[11px] text-slate-500">
              선과 글자로 된 도식·그래프·회로도라면 이쪽이 훨씬 깨끗하게
              인쇄됩니다.
              {config?.configured === false &&
                " (지금은 OPENAI_API_KEY가 설정되지 않아 쓸 수 없습니다.)"}
              {notEnough &&
                ` (남은 사진인식권 ${credits}장으로는 부족합니다.)`}
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

      {isWorking && (
        <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-1000"
              style={{
                width: `${Math.min(90, Math.round((elapsedSec / EXPECTED_SEC) * 90))}%`,
              }}
            />
          </div>
          <p className="text-[11px] text-slate-600">
            {statusText(elapsedSec)} ({elapsedSec}초)
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
          {error}
        </p>
      )}
      {notice && <p className="text-[11px] text-emerald-700">{notice}</p>}

      {showCrop && (
        <DiagramCropModal
          imageSrc={imageSrc}
          purpose="figure"
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
