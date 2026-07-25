"use client";

import { useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { renderMathText } from "@/lib/renderMathText";
import type { RecognizeResponse } from "@/lib/types";

type Props = {
  result: RecognizeResponse;
  onBack: () => void;
  onRestart: () => void;
  /** 지정하면 "오답으로 저장" 버튼이 나타나고, PNG data URL을 인자로 호출된다. */
  onSaveToCategory?: (pngDataUrl: string) => Promise<void>;
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
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [fontSizeIdx, setFontSizeIdx] = useState(1);
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const html = useMemo(
    () => renderMathText(result.text || result.latex),
    [result.text, result.latex],
  );

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
      await onSaveToCategory(dataUrl);
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

      <div
        ref={cardRef}
        className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <div
          className="font-serif leading-relaxed text-ink"
          style={{ fontSize: FONT_SIZES[fontSizeIdx].px }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

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

      <div className="flex flex-wrap justify-end gap-2">
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
        <button
          type="button"
          onClick={onRestart}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          새 이미지로 시작
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          크롭 다시하기
        </button>
        <button
          type="button"
          onClick={handleCopyLatex}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          {copied ? "복사됨!" : "LaTeX 복사"}
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isExporting ? "저장 중..." : "이미지로 저장"}
        </button>
      </div>
    </div>
  );
}
