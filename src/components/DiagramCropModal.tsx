"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { cropImageToDataUrl } from "@/lib/cropImage";
import type { CropRect } from "@/lib/types";

type Props = {
  imageSrc: string;
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
};

/**
 * 원본 사진 위에서 도형 부분만 사람이 직접 오려내게 하는 모달.
 * Mathpix의 자동 감지 영역에 기대지 않고, 사용자가 지정한 영역만 Gemini로
 * 보내야 재구성 결과가 원본과 정확히 일치한다.
 */
export default function DiagramCropModal({ imageSrc, onConfirm, onCancel }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();

  function handleConfirm() {
    const img = imgRef.current;
    if (!img || !crop || !crop.width || !crop.height) return;

    const rect: CropRect = {
      x: (crop.x / 100) * img.naturalWidth,
      y: (crop.y / 100) * img.naturalHeight,
      width: (crop.width / 100) * img.naturalWidth,
      height: (crop.height / 100) * img.naturalHeight,
    };

    onConfirm(cropImageToDataUrl(img, rect));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-auto rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold text-ink">도형 영역 오려내기</h2>
          <p className="text-sm text-slate-500">
            원, 삼각형 같은 도형 부분만 정확히 드래그해서 선택해주세요. 선택한
            부분만 Gemini가 깨끗한 그림으로 다시 그려줍니다.
          </p>
        </div>

        <div className="flex justify-center rounded-2xl bg-slate-100 p-4">
          <ReactCrop crop={crop} onChange={(_, percentCrop) => setCrop(percentCrop)} className="max-h-[65vh]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={imageSrc}
              alt="원본 문제 이미지"
              className="max-h-[65vh] w-auto"
            />
          </ReactCrop>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!crop?.width || !crop?.height}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            이 영역으로 재구성
          </button>
        </div>
      </div>
    </div>
  );
}
