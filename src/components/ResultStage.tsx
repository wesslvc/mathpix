"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { renderMathText, type BoxOverride } from "@/lib/renderMathText";
import type { RecognizeResponse } from "@/lib/types";
import { PROBLEM_CARD_WIDTH } from "@/lib/layout";
import DiagramCropModal from "./DiagramCropModal";
import FigurePanel from "./FigurePanel";
import type { DiagramQuota } from "@/app/api/diagram/quota/route";
import BoxRangeEditor from "./BoxRangeEditor";
import LatexEditor from "./LatexEditor";
import DiagramAdjuster, {
  DEFAULT_DIAGRAM_LAYOUT,
  diagramStyle,
  type DiagramLayout,
} from "./DiagramAdjuster";
import { ANSWER_TYPE_LABEL, formatAnswer, type AnswerType } from "@/lib/answer";

type DiagramModel = "flash" | "lite";

type Props = {
  result: RecognizeResponse;
  onBack: () => void;
  onRestart: () => void;
  /** 지정하면 "오답으로 저장" 버튼이 나타나고, PNG data URL과 정답 정보를 인자로 호출된다. */
  onSaveToCategory?: (payload: {
    pngDataUrl: string;
    /** 사용자가 손본 최종 본문(mmd). 저장되는 텍스트는 이 값이다. */
    text: string;
    answer: string;
    answerType: AnswerType;
    boxOverride: BoxOverride | undefined;
  }) => Promise<void>;
  /** 복수 업로드 시 아직 처리하지 않은 이미지 수. */
  remainingCount?: number;
  /** 다음 대기 이미지로 넘어간다. */
  onNext?: () => void;
  /**
   * 저장 후 곧바로 새 사진을 올릴 수 있게 업로드 화면으로 보낸다.
   * 여러 문제를 연달아 넣을 때 목록으로 돌아갔다 다시 들어오는 왕복을 없앤다.
   */
  onAddAnother?: () => void;
  /** Mathpix에 보낸 원본(크롭된) 이미지. 도형 영역을 오려내는 데 쓴다. */
  sourceImage?: string | null;
};

const FONT_SIZES = [
  { label: "보통", px: 20 },
  { label: "크게", px: 24 },
  { label: "아주 크게", px: 30 },
] as const;

// 도형 재구성은 보통 이 정도(초) 안에 끝난다. 실제 진행률을 알 수 없으니
// 이 값을 기준으로 막대를 서서히 채우되(끝나기 전엔 100%를 보여주면 안
// 되므로 90%에서 멈춘다), 정말 오래 걸리면 안내 문구로 이유를 알려준다.
const VECTORIZE_EXPECTED_SEC = 15;

// 정답 입력이 멎고 이만큼 지나면 자동 저장한다. 너무 짧으면 아직 타는 중에
// 저장되고, 너무 길면 자동 저장을 기다리다 답답하다.
const AUTO_SAVE_SEC = 3;

// 모델 선택 UI 문구. 실제 과금·한도는 서버(0010 마이그레이션의 RPC)가 정하고,
// 여기 숫자는 quota 응답으로 채워 넣는다 — 하드코딩하면 서버와 어긋난다.
const MODEL_LABELS: Record<DiagramModel, string> = {
  lite: "lite",
  flash: "flash",
};

function vectorizeProgressPercent(elapsedSec: number): number {
  return Math.min(90, Math.round((elapsedSec / VECTORIZE_EXPECTED_SEC) * 90));
}

function vectorizeStatusText(elapsedSec: number): string {
  if (elapsedSec < 4) return "이미지를 서버로 보내는 중...";
  if (elapsedSec < 10) return "도형을 분석하고 있어요...";
  if (elapsedSec < 20) return "벡터 이미지로 다시 그리는 중이에요...";
  return "생각보다 오래 걸리네요. 조금만 더 기다려주세요...";
}

export default function ResultStage({
  result,
  onBack,
  onRestart,
  onSaveToCategory,
  remainingCount = 0,
  onNext,
  onAddAnother,
  sourceImage,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [fontSizeIdx, setFontSizeIdx] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [answer, setAnswer] = useState("");
  // 객관식이면 정답표에 "1" 대신 "①"로 표기한다.
  const [answerType, setAnswerType] = useState<AnswerType>("choice");
  // 조건 박스 범위. undefined면 자동 감지에 맡긴다.
  const [boxOverride, setBoxOverride] = useState<BoxOverride | undefined>(undefined);
  const [showBoxEditor, setShowBoxEditor] = useState(false);
  // 도형별 크기·위치. 키는 raster는 도형 id, 수동 SVG는 "svg:<index>".
  const [layouts, setLayouts] = useState<Record<string, DiagramLayout>>({});

  function layoutOf(key: string): DiagramLayout {
    return layouts[key] ?? DEFAULT_DIAGRAM_LAYOUT;
  }
  function setLayout(key: string, next: DiagramLayout) {
    setLayouts((prev) => ({ ...prev, [key]: next }));
  }
  // Mathpix가 자동 감지한 도형 영역을 원본에서 그대로 오려낸 raster 이미지들
  // (도형 id -> data URL). 무료·자동, Gemini 재구성과는 별개다.
  const [rasterFallbacks, setRasterFallbacks] = useState<Record<string, string>>({});
  // "도형 추가인식"으로 사람이 직접 오려내 Gemini가 재구성한 SVG들. 클릭할
  // 때마다 하나씩 쌓인다(문제당 여러 도형이 있으면 여러 번 실행 가능).
  // 크기·위치 설정을 도형별로 따로 들고 있어야 해서 배열 인덱스가 아니라 고정
  // id를 쓴다(인덱스로 키를 잡으면 하나를 지웠을 때 뒤 도형들의 설정이 한 칸씩
  // 밀려 엉뚱한 도형에 적용된다).
  // kind는 조절 목록에 붙는 이름에만 쓴다(수학 도형인지 사과탐 자료인지).
  // 붙는 방식·저장 경로는 둘이 완전히 같다.
  const [manualDiagramSvgs, setManualDiagramSvgs] = useState<
    { id: string; svg: string; kind: "math" | "figure" }[]
  >([]);
  const [showDiagramCrop, setShowDiagramCrop] = useState(false);
  const [isVectorizing, setIsVectorizing] = useState(false);
  const [vectorizeError, setVectorizeError] = useState<string | null>(null);
  // 실패는 아니지만 알려야 하는 일(예: flash 전역 한도가 차서 lite로 그림).
  const [vectorizeNotice, setVectorizeNotice] = useState<string | null>(null);
  // 도형 재구성 API는 스트리밍 응답이 아니라 실제 진행률을 알 방법이 없다.
  // 대신 경과 시간을 세서 "멈춘 게 아니라 원래 오래 걸린다"를 보여준다.
  const [vectorizeElapsedSec, setVectorizeElapsedSec] = useState(0);
  // 어떤 모델로 도형을 재구성할지. 기본은 사진인식권만 쓰는 lite로 둔다
  // (플래시쿠폰은 하루 5장뿐이라 사용자가 의식하고 골라 쓰게 한다).
  const [diagramModel, setDiagramModel] = useState<DiagramModel>("lite");
  // 결제 여부와 남은 수량. null이면 아직 못 불러온 상태.
  const [quota, setQuota] = useState<DiagramQuota | null>(null);

  // 결제 상태와 남은 수량을 불러온다. 도형 기능은 원본 사진이 없어도 카메라로
  // 새로 찍어 쓸 수 있으므로 항상 보여주고, 한 번 쓰고 나면 다시 불러
  // 남은 수량을 갱신한다(refreshQuota).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/diagram/quota")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setQuota(data as DiagramQuota);
      })
      .catch(() => {
        // 잔량을 못 불러와도 버튼은 눌러볼 수 있게 둔다(서버가 최종 판단한다).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshQuota() {
    try {
      const res = await fetch("/api/diagram/quota");
      if (res.ok) setQuota((await res.json()) as DiagramQuota);
    } catch {
      // 갱신 실패는 무시 — 다음 렌더에서 다시 시도된다.
    }
  }

  useEffect(() => {
    if (!isVectorizing) {
      setVectorizeElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setVectorizeElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isVectorizing]);

  // 인식 결과를 그 자리에서 고칠 수 있게 한다. 저장 후 갤러리에서 다시 여는
  // 왕복 없이, 잘못 읽힌 수식을 보면서 바로 손보는 게 훨씬 빠르다.
  const [sourceText, setSourceText] = useState(result.text || result.latex);
  const [showTextEditor, setShowTextEditor] = useState(false);

  // 다음 이미지로 넘어가면 새 인식 결과로 갈아끼운다.
  useEffect(() => {
    setSourceText(result.text || result.latex);
    setShowTextEditor(false);
    setBoxOverride(undefined);
  }, [result]);

  const html = useMemo(
    () => renderMathText(sourceText, boxOverride),
    [sourceText, boxOverride],
  );

  // 정답을 적고 잠시 가만히 있으면 저장 버튼을 누르지 않아도 저장한다.
  // 글자마다 저장하면 "12"를 치는 동안 "1"로 저장되므로 입력이 멎을 때까지 기다린다.
  // 도형·박스를 더 만지려던 참이면 아래 안내에 남은 시간이 보이고, 취소할 수 있다.
  const [autoSaveLeftSec, setAutoSaveLeftSec] = useState<number | null>(null);
  const [autoSaveOff, setAutoSaveOff] = useState(false);

  useEffect(() => {
    if (!onSaveToCategory || autoSaveOff || saved || isSaving) return;
    if (answer.trim() === "") {
      setAutoSaveLeftSec(null);
      return;
    }

    setAutoSaveLeftSec(AUTO_SAVE_SEC);
    const tick = setInterval(() => {
      setAutoSaveLeftSec((v) => (v === null ? null : Math.max(0, v - 1)));
    }, 1000);
    const timer = setTimeout(() => {
      setAutoSaveLeftSec(null);
      void handleSaveToCategory();
    }, AUTO_SAVE_SEC * 1000);

    // 정답을 더 고치면 타이머를 처음부터 다시 센다.
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
    };
    // handleSaveToCategory는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다
    // (넣으면 타이머가 렌더마다 초기화돼 영영 저장되지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, answerType, autoSaveOff, saved, isSaving, onSaveToCategory]);

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

  /**
   * 사람이 오려낸 도형 영역을 Gemini로 보내 깨끗한 SVG로 재구성한다.
   * 과금은 서버가 한다 — lite는 사진인식권 5장, flash는 플래시쿠폰 1장.
   */
  async function handleDiagramCropConfirm(croppedDataUrl: string) {
    setShowDiagramCrop(false);
    setIsVectorizing(true);
    setVectorizeError(null);
    setVectorizeNotice(null);
    try {
      const res = await fetch("/api/diagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: croppedDataUrl, model: diagramModel }),
      });
      let json: {
        svg?: string;
        error?: string;
        /** 서버가 실제로 쓴 모델. 전역 예산이 바닥나면 flash 대신 lite가 온다. */
        model?: DiagramModel;
        /** 요청한 모델과 다르게 처리했을 때의 안내. */
        notice?: string | null;
      };
      try {
        json = await res.json();
      } catch {
        // Vercel이 함수 실행시간 초과 등으로 요청을 강제 종료하면 JSON이 아니라
        // 자체 에러 페이지(HTML/텍스트)를 돌려준다 — 그걸 그대로 파싱하려다
        // 나는 원본 파싱 에러 대신 원인을 짐작할 수 있는 메시지로 바꿔준다.
        throw new Error(
          "서버에서 정상적인 응답을 받지 못했어요. 시간이 너무 오래 걸려 요청이 중단됐을 수 있습니다. 잠시 후 다시 시도해주세요.",
        );
      }
      if (!res.ok) throw new Error(json.error ?? "도형 재구성에 실패했습니다.");
      setManualDiagramSvgs((prev) => [
        ...prev,
        { id: crypto.randomUUID(), svg: json.svg as string, kind: "math" },
      ]);
      // 실패는 아니지만 알려야 하는 경우(flash 전역 한도 소진 → lite로 대체).
      setVectorizeNotice(json.notice ?? null);
    } catch (err) {
      setVectorizeError(
        err instanceof Error ? err.message : "도형 재구성에 실패했습니다.",
      );
    } finally {
      setIsVectorizing(false);
      // 성공이든 실패(=환불)든 서버 잔량이 바뀌었을 수 있으니 다시 읽는다.
      void refreshQuota();
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
    // 자동 저장과 버튼이 겹쳐 두 번 저장되면 같은 문제가 두 개 생긴다.
    if (isSaving || saved) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      await onSaveToCategory({
        pngDataUrl: dataUrl,
        text: sourceText,
        answer: answer.trim(),
        answerType,
        boxOverride,
      });
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
    await navigator.clipboard.writeText(sourceText);
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
          className="problem-surface rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
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
                style={diagramStyle(layoutOf(d.id))}
                className="block max-w-full"
              />
            ) : null,
          )}
          {manualDiagramSvgs.map((d) => (
            <div
              key={d.id}
              style={diagramStyle(layoutOf(d.id))}
              className="block max-w-full [&_svg]:h-auto [&_svg]:w-full"
              dangerouslySetInnerHTML={{ __html: d.svg }}
            />
          ))}
        </div>
      </div>

      {/* 인식 결과를 바로 고친다. 저장 후 갤러리에서 다시 여는 왕복을 없앤다. */}
      <div className="rounded-lg border border-slate-200 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setShowTextEditor((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-medium text-slate-600"
        >
          <span>
            내용 수정
            {sourceText !== (result.text || result.latex) && (
              <span className="ml-1 font-normal text-blue-600">(수정됨)</span>
            )}
          </span>
          <span className="text-slate-400">
            {showTextEditor ? "닫기 ▲" : "열기 ▼"}
          </span>
        </button>
        {showTextEditor && (
          <div className="mt-2 flex flex-col gap-2">
            <LatexEditor value={sourceText} onChange={setSourceText} rows={10} />
            <button
              type="button"
              onClick={() => setSourceText(result.text || result.latex)}
              disabled={sourceText === (result.text || result.latex)}
              className="self-start rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            >
              인식 결과로 되돌리기
            </button>
          </div>
        )}
      </div>

      {/* 조건 박스 범위 조절 — 자동 감지가 어긋났을 때 손으로 고친다. */}
      <div className="rounded-lg border border-slate-200 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setShowBoxEditor((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-medium text-slate-600"
        >
          <span>
            조건 박스 조절
            {boxOverride !== undefined && (
              <span className="ml-1 font-normal text-blue-600">(직접 지정함)</span>
            )}
          </span>
          <span className="text-slate-400">{showBoxEditor ? "닫기 ▲" : "열기 ▼"}</span>
        </button>
        {showBoxEditor && (
          <div className="mt-2">
            <BoxRangeEditor
              text={sourceText}
              value={boxOverride}
              onChange={setBoxOverride}
            />
          </div>
        )}
      </div>

      {/* 도형 크기·위치 조절 — 카드에 실제로 붙은 도형이 있을 때만 보여준다. */}
      {(Object.keys(rasterFallbacks).length > 0 ||
        manualDiagramSvgs.length > 0) && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
          <p className="text-xs font-medium text-slate-500">도형 크기·위치</p>
          {(result.diagrams ?? [])
            .filter((d) => rasterFallbacks[d.id])
            .map((d, i) => (
              <DiagramAdjuster
                key={d.id}
                label={`자동 감지 도형 ${i + 1}`}
                layout={layoutOf(d.id)}
                onChange={(next) => setLayout(d.id, next)}
              />
            ))}
          {manualDiagramSvgs.map((d, idx) => (
            <DiagramAdjuster
              key={d.id}
              label={
                d.kind === "figure"
                  ? `탐구 자료 ${idx + 1}`
                  : `추가인식 도형 ${idx + 1}`
              }
              layout={layoutOf(d.id)}
              onChange={(next) => setLayout(d.id, next)}
              onRemove={() =>
                setManualDiagramSvgs((prev) => prev.filter((p) => p.id !== d.id))
              }
            />
          ))}
        </div>
      )}

      {!isVectorizing && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">도형 화질</span>
            {(["lite", "flash"] as const).map((m) => {
              const selected = diagramModel === m;
              // flash는 결제자 전용이라 미결제 상태면 아예 고를 수 없게 막는다.
              const locked = m === "flash" && quota !== null && !quota.paid;
              const exhausted =
                quota !== null &&
                (m === "flash"
                  ? quota.flashRemaining <= 0 || quota.flashGlobalRemaining <= 0
                  : !quota.liteFree && quota.credits < quota.liteCost);
              return (
                <button
                  key={m}
                  type="button"
                  disabled={locked}
                  onClick={() => setDiagramModel(m)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                    selected
                      ? "border-blue-600 bg-blue-50 text-blue-700"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  } ${locked || exhausted ? "opacity-50" : ""}`}
                >
                  {MODEL_LABELS[m]}
                  {m === "flash" ? " (고화질)" : " (기본)"}
                  {locked && " 🔒"}
                </button>
              );
            })}
          </div>

          <p className="text-[11px] text-slate-500">
            {diagramModel === "flash" ? (
              quota && !quota.paid ? (
                <>flash는 이용권을 구매한 분만 쓸 수 있어요.</>
              ) : (
                <>
                  {quota?.unlimited
                    ? "무제한 계정이라 쿠폰은 차감되지 않아요."
                    : "플래시쿠폰 1장을 씁니다."}
                  {quota && !quota.unlimited &&
                    ` 오늘 ${quota.flashRemaining}/${quota.flashDailyLimit}장 남음 (매일 자정 초기화)`}
                </>
              )
            ) : quota?.unlimited ? (
              <>무제한 계정이라 차감 없이 쓸 수 있어요.</>
            ) : quota?.liteFree ? (
              <>이용권 구매자는 lite를 무료로 쓸 수 있어요.</>
            ) : (
              <>
                사진인식권 {quota?.liteCost ?? 5}장을 씁니다.
                {quota && ` 남은 사진인식권 ${quota.credits}장`}
              </>
            )}
          </p>

          {/* 전역 예산은 개인 잔량과 무관하게 flash를 막으므로 따로 알린다.
              무제한 계정도 예외가 아니다 — 이건 우리 지갑이 아니라 Gemini의
              하루 요청 수 제한이라서 운영자라고 넘길 수 있는 게 아니다. */}
          {diagramModel === "flash" && quota && quota.paid && (
            <p
              className={`text-[11px] ${
                quota.flashGlobalRemaining <= 0
                  ? "text-amber-700"
                  : quota.flashGlobalRemaining <= 3
                    ? "text-amber-600"
                    : "text-slate-400"
              }`}
            >
              {quota.flashGlobalRemaining <= 0
                ? "오늘 flash 전 세대의 사용량이 한도에 찼어요. 지금 누르면 lite로 그려집니다."
                : `오늘 전체 flash 잔여 ${quota.flashGlobalRemaining}/${quota.flashGlobalLimit}건 (모든 사용자 합계)` +
                  (quota.currentFlashModel ? ` · 현재 ${quota.currentFlashModel}` : "")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDiagramCrop(true)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              도형 추가인식
            </button>
            {quota && !quota.paid && (
              <a
                href="/api/checkout"
                className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                이용권 구매 (lite 무료 + flash 사용)
              </a>
            )}
            {vectorizeError && (
              <p className="text-xs text-red-600">{vectorizeError}</p>
            )}
            {vectorizeNotice && (
              <p className="text-xs text-amber-700">{vectorizeNotice}</p>
            )}
          </div>
        </div>
      )}

      {isVectorizing && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
            <span>{vectorizeStatusText(vectorizeElapsedSec)}</span>
            <span className="ml-auto tabular-nums text-slate-400">
              {vectorizeElapsedSec}초 경과
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-1000 ease-linear"
              style={{ width: `${vectorizeProgressPercent(vectorizeElapsedSec)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            도형 재구성은 보통 10~20초 정도 걸려요. 화면을 벗어나지 말고 잠시만 기다려주세요.
          </p>
        </div>
      )}

      {showDiagramCrop && (
        <DiagramCropModal
          imageSrc={sourceImage ?? null}
          onConfirm={handleDiagramCropConfirm}
          onCancel={() => setShowDiagramCrop(false)}
        />
      )}

      {/* 사과탐 자료. 위의 수학 도형과 완전히 별개 경로(다른 API, 다른 모델)지만
          결과가 같은 SVG 문자열이라 manualDiagramSvgs에 그대로 합류한다 —
          크기·위치 조절, PNG 캡처, 저장이 전부 그대로 따라온다. */}
      {!isVectorizing && (
        <FigurePanel
          imageSrc={sourceImage ?? null}
          credits={quota?.credits ?? null}
          unlimited={quota?.unlimited ?? false}
          onAdd={(svg) =>
            setManualDiagramSvgs((prev) => [
              ...prev,
              { id: crypto.randomUUID(), svg, kind: "figure" },
            ])
          }
          onCreditsUsed={() => void refreshQuota()}
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
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-slate-700">
              정답 유형
            </span>
            <div className="flex gap-1">
              {(["choice", "short"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAnswerType(t)}
                  disabled={saved}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                    answerType === t
                      ? "border-blue-600 bg-blue-50 text-blue-700"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {ANSWER_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <span className="shrink-0 font-medium">정답</span>
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              // 정답을 치고 Enter를 누르면 저장 버튼을 따로 누르지 않아도 저장된다.
              // 글자를 칠 때마다 저장하지 않는 이유: 저장은 PNG를 굽고 업로드까지
              // 하는 무거운 동작이라 "12"를 치는 동안 "1"로 저장돼 버린다.
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (answer.trim() === "") return;
                void handleSaveToCategory();
              }}
              disabled={saved}
              placeholder={
                answerType === "choice"
                  ? "예: 3 → 정답표에 ③으로 표기됩니다"
                  : "예: 12 (PDF 맨 뒤 정답표에 표기됩니다)"
              }
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-100"
            />
          </label>
          {!saved && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {autoSaveLeftSec !== null ? (
                <>
                  <span className="text-blue-700">
                    {autoSaveLeftSec}초 후 자동으로 저장돼요.
                  </span>
                  <button
                    type="button"
                    onClick={() => setAutoSaveOff(true)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
                  >
                    자동 저장 끄기
                  </button>
                </>
              ) : (
                <span className="text-slate-400">
                  정답을 입력하면 잠시 뒤 자동 저장돼요.{" "}
                  <kbd className="rounded border border-slate-300 bg-slate-50 px-1">
                    Enter
                  </kbd>
                  를 누르면 바로 저장됩니다.
                  {autoSaveOff && " (자동 저장 꺼짐)"}
                </span>
              )}
            </div>
          )}
          {answer.trim() !== "" && (
            <p className="text-[11px] text-slate-500">
              정답표 표기:{" "}
              <span className="text-sm font-medium text-ink">
                {formatAnswer(answer, answerType)}
              </span>
            </p>
          )}
        </div>
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

      {/* 저장이 끝나면 "다음 문제"를 가장 크게 띄운다 — 여러 개를 연달아 넣는
          것이 이 화면의 기본 사용 패턴이라, 목록으로 돌아갔다 다시 들어오는
          왕복을 없앤다. */}
      {saved && (onAddAnother || (onNext && remainingCount > 0)) && (
        <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-emerald-900">
            저장했어요. 이어서 추가할까요?
          </p>
          <div className="flex flex-wrap gap-2">
            {onNext && remainingCount > 0 ? (
              <button
                type="button"
                onClick={onNext}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                다음 이미지 → ({remainingCount}장 남음)
              </button>
            ) : (
              onAddAnother && (
                <button
                  type="button"
                  onClick={onAddAnother}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  + 다음 문제 추가
                </button>
              )
            )}
          </div>
        </div>
      )}

      {/* 주요 액션: 결과를 실제로 저장/출력하는 버튼만 모아 눈에 띄게 둔다. */}
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
        {!saved && onNext && remainingCount > 0 && (
          <button
            type="button"
            onClick={onNext}
            className="g-btn g-btn-primary"
          >
            다음 이미지 → ({remainingCount}장 남음)
          </button>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="g-btn g-btn-outline"
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
