"use client";

import { useCallback, useRef, useState } from "react";

type Props = {
  onImageSelected: (file: File) => void;
};

export default function ImageUploader({ onImageSelected }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) return;
      onImageSelected(file);
    },
    [onImageSelected],
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
