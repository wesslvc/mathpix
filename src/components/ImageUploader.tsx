"use client";

import { useCallback, useRef, useState } from "react";

type Props = {
  onImageSelected: (file: File) => void;
  onError: (message: string) => void;
};

const HEIC_PATTERN = /\.(heic|heif)$/i;

export default function ImageUploader({ onImageSelected, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;

      if (
        file.type === "image/heic" ||
        file.type === "image/heif" ||
        HEIC_PATTERN.test(file.name)
      ) {
        onError(
          "HEIC/HEIF 형식은 브라우저에서 열 수 없습니다. 아이폰 설정 > 카메라 > 포맷을 '호환 우선'으로 바꾸거나, 사진 공유 시 JPG로 변환해서 다시 시도해주세요.",
        );
        return;
      }

      if (!file.type.startsWith("image/")) return;
      onImageSelected(file);
    },
    [onImageSelected, onError],
  );

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${
        isDragging
          ? "border-blue-500 bg-blue-50"
          : "border-slate-300 bg-white hover:border-slate-400"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
    >
      <div className="text-5xl">📷</div>
      <p className="text-lg font-semibold text-ink">
        문제 이미지를 여기에 끌어다 놓거나 클릭해서 선택하세요
      </p>
      <p className="text-sm text-slate-500">
        JPG, PNG 등 사진 한 장이면 충분합니다. 문제 영역은 자동으로
        인식됩니다.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
