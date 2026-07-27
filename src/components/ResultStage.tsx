"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { renderMathText } from "@/lib/renderMathText";
import type { RecognizeResponse } from "@/lib/types";
import { PROBLEM_CARD_WIDTH } from "@/lib/layout";
import DiagramCropModal from "./DiagramCropModal";

type Props = {
  result: RecognizeResponse;
  onBack: () => void;
  onRestart: () => void;
  /** 지정하면 "오답으로 저장" 버튼이 나타나고, PNG data URL과 정답을 인자로 호출된다. */
  onSaveToCategory?: (pngDataUrl: string, answer: string) => Promise<void>;
  /** 복수 업로드 시 아직 처리하지 않은 이미지 수. */
  remainingCount?: number;
  /** 다음 대기 이미지로 넘어간다. */
  onNext?: () => void;
  /** Mathpix에 보낸 원본(크롭된) 이미지. 도형 영역을 오려내는 데 쓴다. */
  sourceImage?: string | null;
};

const FONT_SIZES = [
  { label: "보통", px: 20 },
  { label: "크게", px: 24 },
  { label: "아주 크게", px: 30 },
] as const;

export default function ResultStage({
  result,
  onBack,
  onRestart,
  onSaveToCategory,
  remainingCount = 0,
  onNext,
  sourceImage,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [fontSizeIdx, setFontSizeIdx] = useState(1);
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [answer, setAnswer] = useState("");
  // Mathpix가 자동 감지한 도형 영역을 원본에서 그대로 오려낸 raster 이미지들
  // (도형 id -> data URL). 무료·자동, Gemini 재구성과는 별개다.
  const [rasterFallbacks, setRasterFallbacks] = useState<Record<string, string>>({});
  // "도형 추가인식"으로 사람이 직접 오려내 Gemini가 재구성한 SVG들. 클릭할
  // 때마다 하나씩 쌓인다(문제당 여러 도형이 있으면 여러 번 실행 가능).
  const [manualDiagramSvgs, setManualDiagramSvgs] = useState<string[]>([]);
  const [showDiagramCrop, setShowDiagramCrop] = useState(false);
  const [isVectorizing, setIsVectorizing] = useState(false);
  const [vectorizeError, setVectorizeError] = useState<string | null>(null);

  const html = useMemo(
    () => renderMathText(result.text || result.latex),
    [result.text, result.latex],
  );

  // Mathpix가 텍스트로 옮길 수 없는 도형(원, 삼각형 등)을 감지하면 그 영역의
  // 좌표를 함께 알려준다. OCR로는 도형을 재구성할 수 없으니, 보낸 원본
  // 이미지에서 그 영역을 그대로 오려내 결과 카드에 이미지로 붙여넣는다.
  useEffect(() => {
    let cancelled = false;
    setRasterFallbacks({});
    if (!sourceImage || !result.diagrams || result.diagrams.length === 0) {
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const crops: Record<string, string> = {};
      for (const d of result.diagrams) {
        const canvas = document.createElement("canvas");
        canvas.width = d.width;
        canvas.height = d.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(
          img,
          d.left,
          d.top,
          d.width,
          d.height,
          0,
          0,
          d.width,
          d.height,
        );
        crops[d.id] = canvas.toDataURL("image/png");
      }
      setRasterFallbacks(crops);
    };
    img.src = sourceImage;

    return () => {
      cancelled = true;
    };
  }, [sourceImage, result.diagrams]);

  /** 사람이 오려낸 도형 영역을 Gemini로 보내 깨끗한 SVG로 재구성한다(사진인식권 2개 차감). */
  async function handleDiagramCropConfirm(croppedDataUrl: string) {
    setShowDiagramCrop(false);
    setIsVectorizing(true);
    setVectorizeError(null);
    try {
      const res = await fetch("/api/diagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: croppedDataUrl }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "도형 재구성에 실패했습니다.");
      setManualDiagramSvgs((prev) => [...prev, json.svg as string]);
    } catch (err) {
      setVectorizeError(
        err instanceof Error ? err.message : "도형 재구성에 실패했습니다.",
      );
    } finally {
      setIsVectorizing(false);
    }
  }

  async function handleExport() {
    if (!cardRef.current) return;
    setIsExporting(true);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      const link = document.createElement("a");
      link.download = "problem.png";
      link.href = dataUrl;
      link.click();
    } finally {
      setIsExporting(false);
    }
  }

  async function handleSaveToCategory() {
    if (!cardRef.current || !onSaveToCategory) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      await onSaveToCategory(dataUrl, answer.trim());
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopyLatex() {
    await navigator.clipboard.writeText(result.latex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /** 렌더링에 실제로 쓰인 원문(mmd)을 복사한다. 줄바꿈/박스 등 렌더링 문제를
   * 알려줄 때 이 텍스트가 필요하다. */
  async function handleCopyText() {
    await navigator.clipboard.writeText(result.text || result.latex);
    setTextCopied(true);
    setTimeout(() => setTextCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-4">
      {result.mock && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Mathpix API 키가 설정되어 있지 않아 예시(mock) 결과를 표시하고
          있습니다. <code>.env.local</code>에 <code>MATHPIX_APP_ID</code>,{" "}
          <code>MATHPIX_APP_KEY</code>를 설정하면 실제 인식 결과가
          표시됩니다.
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">인식 결과</h2>
        <div className="flex items-center gap-1 rounded-lg border border-slate-300 p-1">
          {FONT_SIZES.map((f, idx) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setFontSizeIdx(idx)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                idx === fontSizeIdx
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div
          ref={cardRef}
          className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
          style={{ width: PROBLEM_CARD_WIDTH }}
        >
          <div
            className="font-serif leading-relaxed text-ink"
            style={{ fontSize: FONT_SIZES[fontSizeIdx].px }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {(result.diagrams ?? []).map((d) =>
            rasterFallbacks[d.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={d.id}
                src={rasterFallbacks[d.id]}
                alt="도형"
                className="mx-auto mt-4 max-w-full"
              />
            ) : null,
          )}
          {manualDiagramSvgs.map((svg, idx) => (
            <div
              key={idx}
              className="mx-auto mt-4 max-w-full [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ))}
        </div>
      </div>

      {sourceImage && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDiagramCrop(true)}
            disabled={isVectorizing}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            {isVectorizing ? "도형 재구성 중..." : "도형 추가인식 (사진인식권 2개)"}
          </button>
          {vectorizeError && (
            <p className="text-xs text-red-600">{vectorizeError}</p>
          )}
        </div>
      )}

      {showDiagramCrop && sourceImage && (
        <DiagramCropModal
          imageSrc={sourceImage}
          onConfirm={handleDiagramCropConfirm}
          onCancel={() => setShowDiagramCrop(false)}
        />
      )}

      {result.confidence !== null && (
        <p className="text-xs text-slate-400">
          인식 신뢰도: {(result.confidence * 100).toFixed(0)}%
        </p>
      )}

      {saveError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {onSaveToCategory && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span className="shrink-0 font-medium">정답</span>
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={saved}
            placeholder="예: ③, 5, 12 (PDF 맨 뒤 정답표에 표기됩니다)"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-100"
          />
        </label>
      )}

      {/* 보조 도구: 저장 결과를 만드는 액션이 아니라 다시 시작/복사 같은
          부가 기능이라 작고 옅은 스타일로 아래 주요 액션과 구분한다. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={onRestart}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          새 이미지로 시작
        </button>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          크롭 다시하기
        </button>
        <button
          type="button"
          onClick={handleCopyLatex}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          {copied ? "복사됨!" : "LaTeX 복사"}
        </button>
        <button
          type="button"
          onClick={handleCopyText}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          {textCopied ? "복사됨!" : "텍스트 복사"}
        </button>
      </div>

      {/* 주요 액션: 결과를 실제로 저장/출력하는 버튼만 모아 눈에 띄게 둔다. */}
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
        {onNext && remainingCount > 0 && (
          <button
            type="button"
            onClick={onNext}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            다음 이미지 → ({remainingCount}장 남음)
          </button>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          {isExporting ? "저장 중..." : "이미지로 저장"}
        </button>
        {onSaveToCategory && (
          <button
            type="button"
            onClick={handleSaveToCategory}
            disabled={isSaving || saved}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saved ? "저장됨!" : isSaving ? "저장 중..." : "오답으로 저장"}
          </button>
        )}
      </div>
    </div>
  );
}
