"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onImagesSelected: (files: File[]) => void;
  onError: (message: string) => void;
};

const HEIC_PATTERN = /\.(heic|heif)$/i;

function isHeic(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    HEIC_PATTERN.test(file.name)
  );
}

export default function ImageUploader({ onImagesSelected, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (fileList: FileList | File[] | null) => {
      if (!fileList) return;
      const files = Array.from(fileList);
      if (files.length === 0) return;

      // HEIC/HEIF는 브라우저에서 못 여니 하나라도 있으면 안내하고 나머지만 처리.
      const hasHeic = files.some(isHeic);
      const images = files.filter(
        (f) => !isHeic(f) && f.type.startsWith("image/"),
      );

      if (images.length === 0) {
        if (hasHeic) {
          onError(
            "HEIC/HEIF 형식은 브라우저에서 열 수 없습니다. 아이폰 설정 > 카메라 > 포맷을 '호환 우선'으로 바꾸거나, 사진 공유 시 JPG로 변환해서 다시 시도해주세요.",
          );
        }
        return;
      }

      if (hasHeic) {
        onError(
          "HEIC/HEIF 사진 일부는 제외했습니다. 나머지 사진만 불러옵니다.",
        );
      }
      onImagesSelected(images);
    },
    [onImagesSelected, onError],
  );

  // 붙여넣기(Ctrl+V)로 클립보드의 이미지를 바로 넣을 수 있게 한다.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        handleFiles(files);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFiles]);

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
      <p className="text-lg font-semibold text-ink dark:text-[#e8eaed]">
        문제 이미지를 여기에 끌어다 놓거나 클릭해서 선택하세요
      </p>
      <p className="text-sm text-slate-500 dark:text-[#9aa0a6]">
        여러 장을 한 번에 선택하거나, 캡처한 사진을{" "}
        <kbd className="rounded border border-slate-300 dark:border-[#4a4d51] bg-slate-50 dark:bg-[#2a2b2e] px-1 text-xs">
          Ctrl
        </kbd>
        +
        <kbd className="rounded border border-slate-300 dark:border-[#4a4d51] bg-slate-50 dark:bg-[#2a2b2e] px-1 text-xs">
          V
        </kbd>{" "}
        로 붙여넣어도 됩니다. 문제 영역은 자동으로 인식됩니다.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
