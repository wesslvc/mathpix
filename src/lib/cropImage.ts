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
  /**
   * 가로·세로를 따로 제한하고 싶을 때.
   *
   * 기본값은 **긴 변** 기준인데, 세로로 긴 문제에서는 그러면 폭이 무너진다
   * (글자 크기는 폭으로 정해진다). 문제 전체를 모델에 보낼 때는 폭을 지켜야
   * 해서 이 길로 부른다.
   */
  limits?: { maxWidth: number; maxHeight: number },
): string {
  const cropWidth = Math.max(1, Math.round(rect.width));
  const cropHeight = Math.max(1, Math.round(rect.height));

  const scale = limits
    ? Math.min(1, limits.maxWidth / cropWidth, limits.maxHeight / cropHeight)
    : Math.min(1, MAX_DIMENSION / Math.max(cropWidth, cropHeight));
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
    // onerror의 인자는 Error가 아니라 원시 Event다. 그대로 reject에 넘기면
    // 이 실패가 `err instanceof Error` 로 걸러지는 모든 catch 블록에서
    // 조용히 일반 문구("~에 실패했습니다")로 뭉개진다 — 실제로 가채점
    // 화면에서 HEIC 사진을 골랐을 때 "채점에 실패했습니다"만 뜨고 이유를
    // 알 수 없었다. Error로 감싸 항상 사람이 읽을 문구가 나오게 한다.
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = src;
  });
}
