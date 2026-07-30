import type { CropRect } from "./types";

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.9;

/**
 * 원본 이미지에서 주어진 영역(원본 픽셀 좌표 기준)을 잘라 data URL로 반환한다.
 * 실제 카메라 사진은 무압축 PNG로 인코딩하면 문자열이 수십 MB까지 커져
 * 일부 모바일 브라우저(특히 Safari)에서 요청 자체가 실패하는 경우가 있어,
 * 긴 변을 MAX_DIMENSION 이하로 축소하고 JPEG로 압축해 전송 크기를 줄인다.
 */
export function cropImageToDataUrl(
  image: HTMLImageElement,
  rect: CropRect,
): string {
  const cropWidth = Math.max(1, Math.round(rect.width));
  const cropHeight = Math.max(1, Math.round(rect.height));

  const scale = Math.min(1, MAX_DIMENSION / Math.max(cropWidth, cropHeight));
  const outWidth = Math.max(1, Math.round(cropWidth * scale));
  const outHeight = Math.max(1, Math.round(cropHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");

  ctx.drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    outWidth,
    outHeight,
  );

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

const HEIC_PATTERN = /\.(heic|heif)$/i;

export function isHeicFile(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    HEIC_PATTERN.test(file.name)
  );
}

/**
 * 사용자가 새로 찍거나 고른 사진 파일을 화면에 띄울 수 있는 data URL로 바꾼다.
 * 카메라 원본은 수천 px이라 그대로 data URL로 만들면 문자열이 수십 MB가 되어
 * Safari에서 터진다 — 크롭할 때와 같은 기준(긴 변 1600px, JPEG)으로 줄인다.
 */
export async function fileToDataUrl(file: File): Promise<string> {
  if (isHeicFile(file)) {
    throw new Error(
      "HEIC/HEIF 형식은 브라우저에서 열 수 없습니다. 아이폰 설정 > 카메라 > 포맷을 '호환 우선'으로 바꾼 뒤 다시 찍어주세요.",
    );
  }
  if (!file.type.startsWith("image/")) {
    throw new Error("이미지 파일만 사용할 수 있습니다.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(
      1,
      MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
