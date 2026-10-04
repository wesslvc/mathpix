"use client";

import { useEffect, useRef, useState } from "react";
import { SOL_TYPESET_TOKENS } from "@/lib/tokens";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { detectContentRegion } from "@/lib/autoDetectRegion";
import { rotateImageDataUrl } from "@/lib/cropImage";
import { cropRegionToDataUrl, rectPoly, type Region } from "@/lib/polygon";
import { useCropShape } from "@/lib/cropShape";
import { inkMapFromImage, snapBoxes } from "@/lib/snapBoxes";
import BoxEditor, { type EditBox } from "./BoxEditor";
import CropShapeToggle from "./CropShapeToggle";
import { Button } from "@/components/ui/button";

type Props = {
  imageSrc: string;
  /**
   * mode가 "problem"이면 인식(Mathpix) 대신 문제 전체를 이미지로 다시 그린다.
   * 탐구처럼 표·지도·그림이 뒤섞인 문제는 그 편이 원본에 가깝다.
   */
  onConfirm: (croppedDataUrl: string, mode: "ocr" | "problem" | "asis" | "sol") => void;
  /** 문제 전체 다시 그리기에 드는 토큰. 못 불러왔으면 표시하지 않는다. */
  problemTokenCost?: number | null;
  /** 무제한 계정인가. 토큰 비용 표시를 감춘다. */
  unlimited?: boolean;
  /**
   * BYOK 패스 계정인가. 본인 키로 직접 내므로 "통째로 AI로 다시 그리기"에
   * 토큰 비용을 붙여 보여주면 안 된다(실제로도 안 든다).
   */
  byok?: boolean;
  onCancel: () => void;
  onError: (message: string) => void;
  /** 이 사진을 건너뛴다(대기열 맨 뒤로). 여러 장을 넣을 때만 준다. */
  onSkip?: () => void;
  /**
   * luna 가 잡은 문제 자리(사진 대비 비율). `undefined` = 아직 자르는 중, `null` = 못 찾음(또는 안 씀) — 그때는 화면의
   * 계산(`detectContentRegion`)을 그대로 둔다. 사용자가 손대기 전에 도착하면 그 자리로 바꾼다.
   */
  aiRegion?: Region | null;
};

/** luna 자리를 글자에 맞춰 다듬은 뒤 두르는 여유(사방). 딱 맞게 자르면 획 끝이 잘릴 수 있다. */
const AI_PAD = 0.006;

/** 한 문제 자르기에서 영역을 가리키는 id. 하나뿐이라 고정값이다. */
const ONE = "crop";

export default function CropStage({
  imageSrc,
  onConfirm,
  onCancel,
  onError,
  onSkip,
  problemTokenCost,
  unlimited = false,
  byok = false,
  aiRegion,
}: Props) {
  /** 자를 재료. 화면에 뜬 `<img>` 가 아니라 따로 연 것이라 모양을 바꿔도 그대로다. */
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** 자를 자리(사진 대비 비율). 다각형이면 `poly` 가 있다. */
  const [region, setRegion] = useState<Region | null>(null);
  const [autoDetected, setAutoDetected] = useState(false);
  const [shape, setShape] = useCropShape();
  /** 자동 감지는 사진마다 한 번만 한다 — 모양을 바꿀 때 그림이 다시 붙어도 덮지 않는다. */
  const detectedFor = useRef<string | null>(null);
  /** 사용자가 자리를 손댔다 — 그 뒤에 도착한 luna 자리로 덮지 않는다. */
  const touched = useRef(false);
  /** luna 자리를 이미 얹었다. */
  const [aiApplied, setAiApplied] = useState(false);
  const aiRef = useRef(aiRegion);
  aiRef.current = aiRegion;

  /**
   * 사진 돌리기. 세로로 찍힌 사진이 누워서 들어오는 일이 흔하다.
   *
   * **횟수만 세어 두고 늘 원본을 돌린다** — 돌린 결과를 또 돌리면 누를 때마다
   * JPEG 를 다시 저장해 글자가 조금씩 뭉개진다. 돌아간 사진 자체를 `<img>` 에
   * 물리므로 크롭 좌표·자동 감지는 손댈 것이 없다(둘 다 지금 그림을 본다).
   */
  const [turns, setTurns] = useState(0);
  const [shown, setShown] = useState(imageSrc);
  const rootRef = useRef<HTMLDivElement>(null);

  // 휴대폰에서는 사진이 바뀔 때마다 자르는 화면을 위로 붙인다 — 머리글·사진 줄
  // 아래로 밀려 있으면 사진 아랫부분이 아래 버튼 줄에 가려 그 자리를 못 누른다.
  // 여러 장을 연달아 넣을 때 매번 손으로 스크롤하던 수고도 던다.
  useEffect(() => {
    if (window.innerWidth >= 640) return;
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [imageSrc]);

  useEffect(() => {
    let alive = true;
    rotateImageDataUrl(imageSrc, turns)
      .then((next) => {
        if (alive) setShown(next);
      })
      .catch(() => {
        // 돌리지 못했으면 원본 그대로 둔다 — 여기서 막으면 아예 못 넣는다.
        if (alive) setShown(imageSrc);
      });
    return () => {
      alive = false;
    };
  }, [imageSrc, turns]);

  // 네모로 돌아가면 다각형은 감싸는 네모로 접는다.
  useEffect(() => {
    if (shape === "rect") setRegion((r) => (r ? { x: r.x, y: r.y, w: r.w, h: r.h } : r));
  }, [shape]);

  function handleImageError() {
    onError(
      "이미지를 불러올 수 없습니다. 이 브라우저가 지원하지 않는 형식(HEIC 등)일 수 있으니 JPG/PNG로 다시 시도해주세요.",
    );
  }

  /**
   * luna 자리를 얹는다 — 돌리지 않은 사진이고 사용자가 아직 손대지 않았을 때만(luna 는 돌리기 전 사진을 봤다).
   * 테두리는 사진의 글자에 맞춰 다듬는다(`snapBoxes` — 지면 통째로 넣기와 같은 판단, 모델 테두리는 1~2% 어긋난다).
   */
  function applyAi(img: HTMLImageElement) {
    const box = aiRef.current;
    if (!box || touched.current || turns !== 0) return;
    let b = { x: box.x, y: box.y, w: box.w, h: box.h };
    const map = inkMapFromImage(img, img.naturalWidth, img.naturalHeight);
    if (map) b = snapBoxes(map, [b]).boxes[0] ?? b;
    const x0 = Math.max(0, b.x - AI_PAD);
    const y0 = Math.max(0, b.y - AI_PAD);
    const x1 = Math.min(1, b.x + b.w + AI_PAD);
    const y1 = Math.min(1, b.y + b.h + AI_PAD);
    setRegion({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    setAiApplied(true);
  }

  function handleImageLoad(img: HTMLImageElement) {
    imgRef.current = img;
    if (detectedFor.current === shown) return;
    detectedFor.current = shown;
    const rect = detectContentRegion(img);
    setRegion({
      x: rect.x / img.naturalWidth,
      y: rect.y / img.naturalHeight,
      w: rect.width / img.naturalWidth,
      h: rect.height / img.naturalHeight,
    });
    setAutoDetected(true);
    applyAi(img);
  }

  // luna 자리가 사진이 뜬 뒤에 도착했으면 그때 얹는다.
  useEffect(() => {
    if (aiRegion && imgRef.current && detectedFor.current === shown && !aiApplied) applyAi(imgRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRegion]);

  /** 사용자가 자리를 바꿨다(끌기·전체·새로 그리기·돌리기). */
  function userSetRegion(r: Region | null) {
    touched.current = true;
    setRegion(r);
  }

  const ready = !!region && region.w > 0 && region.h > 0;

  function handleConfirm(mode: "ocr" | "problem" | "asis" | "sol") {
    const img = imgRef.current;
    if (!img || !region || !ready) return;
    onConfirm(cropRegionToDataUrl(img, region), mode);
  }

  const percentCrop: Crop | undefined = region
    ? { unit: "%", x: region.x * 100, y: region.y * 100, width: region.w * 100, height: region.h * 100 }
    : undefined;

  const editBoxes: EditBox[] = region
    ? [{ id: ONE, group: ONE, ...region, poly: region.poly ?? rectPoly(region) }]
    : [];

  return (
    <div ref={rootRef} className="flex scroll-mt-14 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">문제 영역 자르기</h2>
          <p className="text-xs text-slate-500">
            {!autoDetected
              ? "사진을 여는 중…"
              : shape === "poly"
                ? "점을 끌어 모양을 맞추세요. 변 가운데 점을 끌면 점이 늘어요."
                : aiApplied
                  ? "luna 가 문제 자리를 잘랐어요. 손잡이를 끌어 범위를 맞추세요."
                  : aiRegion === undefined && !touched.current && turns === 0
                    ? "자동으로 잡았어요 · luna 가 더 정확히 자르는 중…"
                    : "자동으로 잡았어요. 손잡이를 끌어 범위를 맞추세요."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CropShapeToggle value={shape} onChange={setShape} />
          <Button
            type="button"
            onClick={() => {
              touched.current = true;
              setTurns((t) => t + 1);
            }}
            variant="outline" size="sm"
          >
            ↻ 돌리기
          </Button>
          <Button
            type="button"
            onClick={() => userSetRegion({ x: 0.02, y: 0.02, w: 0.96, h: 0.96 })}
            variant="outline" size="sm"
          >
            전체
          </Button>
          {shape === "poly" && (
            <Button
              type="button"
              onClick={() => userSetRegion(null)}
              variant="outline" size="sm"
              title="지우고 점을 새로 찍습니다"
            >
              새로 그리기
            </Button>
          )}
        </div>
      </div>

      <div className="flex justify-center rounded-2xl bg-slate-100 p-3 sm:p-4">
        {shape === "rect" ? (
          <ReactCrop
            crop={percentCrop}
            onChange={(_, pc) =>
              userSetRegion({ x: pc.x / 100, y: pc.y / 100, w: pc.width / 100, h: pc.height / 100 })
            }
            className="max-h-[58vh] sm:max-h-[70vh]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              // 돌릴 때마다 src 가 바뀌므로 key 도 함께 바뀌어 onLoad 가 다시
              // 불린다 — 돌아간 그림으로 자동 영역 감지를 새로 한다.
              key={shown}
              src={shown}
              alt="업로드한 문제 이미지"
              onLoad={(e) => handleImageLoad(e.currentTarget)}
              onError={handleImageError}
              className="max-h-[58vh] w-auto sm:max-h-[70vh]"
            />
          </ReactCrop>
        ) : (
          <BoxEditor
            key={shown}
            image={shown}
            boxes={editBoxes}
            onChange={(list) => {
              const b = list[list.length - 1];
              userSetRegion(b ? { x: b.x, y: b.y, w: b.w, h: b.h, poly: b.poly } : null);
            }}
            shape="poly"
            single
            fit="contain"
            color="#2f74b8"
            onImageLoad={handleImageLoad}
            onImageError={handleImageError}
          />
        )}
      </div>

      {/* 누르는 자리는 화면 아래에 붙여 둔다 — 휴대폰에서 자르고 나서 버튼까지
          스크롤하지 않게. 여러 장을 넣을 때 가장 자주 누르는 자리다. */}
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <div className="flex items-center gap-1 sm:mr-auto">
          <Button type="button" onClick={onCancel} variant="ghost" size="sm">
            닫기
          </Button>
          {onSkip && (
            <Button type="button" onClick={onSkip} variant="ghost" size="sm" title="이 사진은 나중에 자릅니다">
              건너뛰기
            </Button>
          )}
        </div>
        {/* 휴대폰에서는 두 칸씩 두 줄 — 한 손으로 연달아 누르는 자리다. */}
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {/* 이미 깨끗한 인쇄물이면 다시 그릴 이유가 없다. 인식도 생성도 하지 않으므로
              여기서 드는 것은 번호를 읽는 비용뿐이다. */}
          <Button
            type="button"
            onClick={() => handleConfirm("asis")}
            disabled={!ready}
            variant="outline" className="whitespace-normal px-2 text-[13px] leading-tight sm:px-4 sm:text-sm"
          >
            원본 그대로
          </Button>
          {/* 탐구처럼 표·지도·그림이 뒤섞인 문제는 글자로 옮겨 재구성하는 것보다
              통째로 다시 그리는 편이 원본에 가깝다. */}
          <Button
            type="button"
            onClick={() => handleConfirm("problem")}
            disabled={!ready}
            variant="soft" className="flex-col gap-0 whitespace-normal px-2 text-[13px] leading-tight sm:flex-row sm:gap-1.5 sm:px-4 sm:text-sm"
          >
            AI로 다시 그리기
            {typeof problemTokenCost === "number" && !unlimited && !byok && (
              <span className="text-[10px] font-medium opacity-70 sm:text-[11px]">{problemTokenCost}토큰</span>
            )}
            {byok && <span className="text-[10px] font-medium opacity-70 sm:text-[11px]">본인 키</span>}
          </Button>
          {/* sol 이 글자로 옮겨 적고 우리가 조판한다(수정 창의 "sol 인식 후 조판"과 같은 작업). 글자가 정확하고
              본문을 고칠 수 있다 — 그래프·지도 같은 그림은 원본에서 오려 붙인다. 넣자마자 다음 사진으로 넘어간다. */}
          <Button
            type="button"
            onClick={() => handleConfirm("sol")}
            disabled={!ready}
            variant="soft" className="flex-col gap-0 whitespace-normal px-2 text-[13px] leading-tight sm:flex-row sm:gap-1.5 sm:px-4 sm:text-sm"
          >
            sol로 인식
            {!unlimited && !byok && (
              <span className="text-[10px] font-medium opacity-70 sm:text-[11px]">{SOL_TYPESET_TOKENS}토큰</span>
            )}
            {byok && <span className="text-[10px] font-medium opacity-70 sm:text-[11px]">본인 키</span>}
          </Button>
          <Button
            type="button"
            onClick={() => handleConfirm("ocr")}
            disabled={!ready}
            variant="primary" className="whitespace-normal px-2 text-[13px] leading-tight sm:px-4 sm:text-sm"
          >
            글자로 인식
          </Button>
        </div>
      </div>
    </div>
  );
}
