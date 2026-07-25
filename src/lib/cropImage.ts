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

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
