"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { cropImageToDataUrl, fileToDataUrl } from "@/lib/cropImage";
import type { CropRect } from "@/lib/types";

/**
 * 무엇을 오려내는 중인가. 오려내는 동작은 똑같고 안내 문구와 확인 버튼만 다르다.
 *   math   : 수학 도형
 *   figure : 사과탐 자료
 * 어느 쪽이든 뒤 화면에서 "원본 그대로"와 "AI로 다시 그리기"를 고른다.
 */
export type CropPurpose = "math" | "figure";

const COPY: Record<
  CropPurpose,
  { title: string; description: string; confirm: string }
> = {
  math: {
    title: "도형 오려내기",
    description:
      "원, 삼각형 같은 도형 부분만 정확히 드래그해서 선택해주세요. 다음 화면에서 원본을 그대로 붙일지 AI로 다시 그릴지 고를 수 있습니다.",
    confirm: "이 영역으로 재구성",
  },
  figure: {
    title: "자료 영역 오려내기",
    description:
      "실험 장치, 모식도, 그래프, 표 같은 자료 부분만 드래그해서 선택해주세요. 다음 화면에서 원본을 그대로 붙일지 다시 그릴지 고를 수 있습니다.",
    confirm: "이 영역 사용",
  },
};

type Props = {
  /**
   * 문제를 인식할 때 쓴 원본(크롭된) 사진. 여기서 도형을 오려낼 수 있다.
   * null이면(원본을 못 쓰는 경우) 새로 찍은 사진만 쓸 수 있다.
   */
  imageSrc: string | null;
  /** 안내 문구를 어느 쪽으로 보여줄지. 기본은 기존 동작(수학). */
  purpose?: CropPurpose;
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
};

/**
 * 도형 부분만 사람이 직접 오려내게 하는 모달.
 * Mathpix의 자동 감지 영역에 기대지 않고, 사용자가 지정한 영역만 보내야
 * 재구성 결과가 원본과 정확히 일치한다.
 *
 * 오려낼 사진은 두 가지 중에 고른다:
 *   - 기존 사진 : 문제를 인식할 때 쓴 그 사진
 *   - 새로 촬영 : 카메라를 열어 도형만 다시 찍는다. 원본 사진에서 도형이
 *                작게/흐리게 나왔거나, 아예 다른 지면에 있는 도형을 붙이고
 *                싶을 때 쓴다.
 */
export default function DiagramCropModal({
  imageSrc,
  purpose = "math",
  onConfirm,
  onCancel,
}: Props) {
  const copy = COPY[purpose];
  const imgRef = useRef<HTMLImageElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [crop, setCrop] = useState<Crop>();
  // null이면 기존 사진을 쓰는 중. 새로 찍으면 그 사진의 data URL이 들어간다.
  const [newPhoto, setNewPhoto] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const activeSrc = newPhoto ?? imageSrc;

  async function handlePicked(file: File | undefined) {
    if (!file) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      setNewPhoto(dataUrl);
      // 사진이 바뀌면 이전 선택 영역은 의미가 없다.
      setCrop(undefined);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "사진을 불러오지 못했습니다.",
      );
    } finally {
      setIsLoading(false);
    }
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

    onConfirm(cropImageToDataUrl(img, rect));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-4 overflow-auto rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold text-ink">{copy.title}</h2>
          <p className="text-sm text-slate-500">{copy.description}</p>
        </div>

        {/* 어느 사진에서 오려낼지 고른다. */}
        <div className="flex flex-wrap items-center gap-2">
          {imageSrc !== null && (
            <button
              type="button"
              onClick={() => {
                setNewPhoto(null);
                setCrop(undefined);
                setLoadError(null);
              }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                newPhoto === null
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              기존 사진에서
            </button>
          )}
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              newPhoto !== null
                ? "border-blue-600 bg-blue-50 text-blue-700"
                : "border-slate-300 text-slate-600 hover:bg-slate-100"
            }`}
          >
            📷 카메라로 찍기
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            🖼 다른 사진 선택
          </button>
          {newPhoto !== null && (
            <span className="text-[11px] text-slate-400">새로 찍은 사진 사용 중</span>
          )}
        </div>

        {/* capture 속성이 있으면 모바일에서 갤러리 대신 카메라가 바로 열린다.
            데스크톱은 이 속성을 무시하고 파일 선택창을 띄우므로, 카메라가 없는
            환경에서도 막히지 않는다. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void handlePicked(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void handlePicked(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        {loadError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {loadError}
          </p>
        )}

        <div className="flex justify-center rounded-2xl bg-slate-100 p-4">
          {isLoading ? (
            <p className="py-16 text-sm text-slate-500">사진을 불러오는 중...</p>
          ) : activeSrc === null ? (
            <p className="py-16 text-center text-sm text-slate-500">
              위의 <span className="font-medium">📷 카메라로 찍기</span>를 눌러
              도형을 찍어주세요.
            </p>
          ) : (
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              className="max-h-[65vh]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                // 사진이 바뀌면 <img>를 새로 만들어 이전 이미지의 naturalWidth가
                // 남아 크롭 좌표가 어긋나는 일이 없게 한다.
                key={activeSrc}
                src={activeSrc}
                alt="도형을 오려낼 사진"
                className="max-h-[65vh] w-auto"
              />
            </ReactCrop>
          )}
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
            disabled={!crop?.width || !crop?.height || isLoading || activeSrc === null}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
