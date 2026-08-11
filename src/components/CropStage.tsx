"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { detectContentRegion } from "@/lib/autoDetectRegion";
import { cropImageToDataUrl } from "@/lib/cropImage";
import type { CropRect } from "@/lib/types";

type Props = {
  imageSrc: string;
  /**
   * mode가 "problem"이면 인식(Mathpix) 대신 문제 전체를 이미지로 다시 그린다.
   * 탐구처럼 표·지도·그림이 뒤섞인 문제는 그 편이 원본에 가깝다.
   */
  onConfirm: (croppedDataUrl: string, mode: "ocr" | "problem") => void;
  /** 문제 전체 다시 그리기에 드는 토큰. 못 불러왔으면 표시하지 않는다. */
  problemTokenCost?: number | null;
  onCancel: () => void;
  onError: (message: string) => void;
};

function rectToPercentCrop(rect: CropRect, naturalWidth: number, naturalHeight: number): Crop {
  return {
    unit: "%",
    x: (rect.x / naturalWidth) * 100,
    y: (rect.y / naturalHeight) * 100,
    width: (rect.width / naturalWidth) * 100,
    height: (rect.height / naturalHeight) * 100,
  };
}

export default function CropStage({
  imageSrc,
  onConfirm,
  onCancel,
  onError,
  problemTokenCost,
}: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [autoDetected, setAutoDetected] = useState(false);

  function handleImageError() {
    onError(
      "이미지를 불러올 수 없습니다. 이 브라우저가 지원하지 않는 형식(HEIC 등)일 수 있으니 JPG/PNG로 다시 시도해주세요.",
    );
  }

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    imgRef.current = img;

    const rect = detectContentRegion(img);
    setCrop(rectToPercentCrop(rect, img.naturalWidth, img.naturalHeight));
    setAutoDetected(true);
  }

  function handleConfirm(mode: "ocr" | "problem") {
    const img = imgRef.current;
    if (!img || !crop || !crop.width || !crop.height) return;

    const rect: CropRect = {
      x: (crop.x / 100) * img.naturalWidth,
      y: (crop.y / 100) * img.naturalHeight,
      width: (crop.width / 100) * img.naturalWidth,
      height: (crop.height / 100) * img.naturalHeight,
    };

    const dataUrl = cropImageToDataUrl(img, rect);
    onConfirm(dataUrl, mode);
  }

  function handleResetToFull() {
    const img = imgRef.current;
    if (!img) return;
    setCrop({ unit: "%", x: 2, y: 2, width: 96, height: 96 });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            문제 영역 확인 및 조정
          </h2>
          <p className="text-sm text-slate-500">
            {autoDetected
              ? "자동으로 문제 영역을 인식했습니다. 필요하면 손잡이를 끌어 범위를 조정하세요."
              : "이미지를 분석하는 중입니다..."}
          </p>
        </div>
        <button
          type="button"
          onClick={handleResetToFull}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
        >
          전체 이미지로 리셋
        </button>
      </div>

      <div className="flex justify-center rounded-2xl bg-slate-100 p-4">
        <ReactCrop
          crop={crop}
          onChange={(_, percentCrop) => setCrop(percentCrop)}
          className="max-h-[70vh]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc}
            alt="업로드한 문제 이미지"
            onLoad={handleImageLoad}
            onError={handleImageError}
            className="max-h-[70vh] w-auto"
          />
        </ReactCrop>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          다른 이미지 선택
        </button>
        {/* 탐구처럼 표·지도·그림이 뒤섞인 문제는 글자로 옮겨 재구성하는 것보다
            통째로 다시 그리는 편이 원본에 가깝다. 대신 결과가 이미지라 나중에
            본문을 고칠 수 없으므로, 기본은 여전히 인식이다. */}
        <button
          type="button"
          onClick={() => handleConfirm("problem")}
          disabled={!crop?.width || !crop?.height}
          className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          통째로 AI로 다시 그리기
          {typeof problemTokenCost === "number" && ` (${problemTokenCost}토큰)`}
        </button>
        <button
          type="button"
          onClick={() => handleConfirm("ocr")}
          disabled={!crop?.width || !crop?.height}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          이 영역으로 인식하기
        </button>
      </div>
    </div>
  );
}
