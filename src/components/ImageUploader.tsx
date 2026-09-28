"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onImagesSelected: (files: File[]) => void;
  onError: (message: string) => void;
  /** 문제 넣기 탭 안에 들어갈 때의 낮은 모양. */
  compact?: boolean;
  /**
   * 붙여넣기(Ctrl+V)를 받을지. 이 칸이 감춰진 탭 안에 있어도 붙여넣기는
   * 화면 전체에서 받으므로, 보이지 않을 때는 꺼 둔다.
   */
  pasteEnabled?: boolean;
};

const HEIC_PATTERN = /\.(heic|heif)$/i;

function isHeic(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    HEIC_PATTERN.test(file.name)
  );
}

export default function ImageUploader({ onImagesSelected, onError, compact = false, pasteEnabled = true }: Props) {
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
    if (!pasteEnabled) return;
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
  }, [handleFiles, pasteEnabled]);

  return (
    <div
      className={`group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center transition-colors ${
        compact ? "px-6 py-8" : "p-12"
      } ${
        isDragging
          ? "border-blue-500 bg-blue-50"
          : "border-slate-200 bg-slate-50/60 hover:border-blue-300 hover:bg-blue-50/40"
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
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200 transition group-hover:scale-105">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-sm font-semibold text-ink sm:text-base">
        문제 사진을 끌어다 놓거나 눌러서 고르세요
      </p>
      <p className="text-xs text-slate-500">
        여러 장을 한 번에 골라도 돼요 · 캡처는{" "}
        <kbd className="rounded border border-slate-300 bg-white px-1 text-[10px]">Ctrl</kbd>+
        <kbd className="rounded border border-slate-300 bg-white px-1 text-[10px]">V</kbd> 로 붙여넣기
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          // 같은 사진을 다시 골라도 onChange 가 오도록 비운다.
          e.target.value = "";
        }}
      />
    </div>
  );
}
