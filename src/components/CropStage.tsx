"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { detectContentRegion } from "@/lib/autoDetectRegion";
import { cropImageToDataUrl } from "@/lib/cropImage";
import type { CropRect } from "@/lib/types";

type Props = {
  imageSrc: string;
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
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

export default function CropStage({ imageSrc, onConfirm, onCancel }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [autoDetected, setAutoDetected] = useState(false);

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    imgRef.current = img;

    const rect = detectContentRegion(img);
    setCrop(rectToPercentCrop(rect, img.naturalWidth, img.naturalHeight));
    setAutoDetected(true);
  }

  function handleConfirm() {
    const img = imgRef.current;
    if (!img || !crop || !crop.width || !crop.height) return;

    const rect: CropRect = {
      x: (crop.x / 100) * img.naturalWidth,
      y: (crop.y / 100) * img.naturalHeight,
      width: (crop.width / 100) * img.naturalWidth,
      height: (crop.height / 100) * img.naturalHeight,
    };

    const dataUrl = cropImageToDataUrl(img, rect);
    onConfirm(dataUrl);
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
            className="max-h-[70vh] w-auto"
          />
        </ReactCrop>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          다른 이미지 선택
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!crop?.width || !crop?.height}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          이 영역으로 인식하기
        </button>
      </div>
    </div>
  );
}
