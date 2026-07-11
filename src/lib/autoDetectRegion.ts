import type { CropRect } from "./types";

/**
 * 이미지에서 "잉크(글씨/도형)"가 있는 영역의 경계 상자를 추정한다.
 * 문제집/시험지 사진처럼 밝은 배경 위에 어두운 글씨가 있는 경우를 가정한
 * 단순 휴리스틱이며, Mathpix API 연동 전 사용자가 편집할 초기 크롭 값을
 * 제공하기 위한 용도다. 최종 정확도는 다음 단계의 수동 크롭에서 사용자가
 * 보정한다.
 */
export function detectContentRegion(image: HTMLImageElement): CropRect {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;

  const fallback: CropRect = {
    x: 0,
    y: 0,
    width: naturalWidth,
    height: naturalHeight,
  };

  if (!naturalWidth || !naturalHeight) return fallback;

  // 성능을 위해 축소한 캔버스에서 분석하고, 결과 좌표를 원본 크기로 환산한다.
  const maxDim = 700;
  const scale = Math.min(1, maxDim / Math.max(naturalWidth, naturalHeight));
  const sampleWidth = Math.max(1, Math.round(naturalWidth * scale));
  const sampleHeight = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;

  ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  } catch {
    // 캔버스가 오염된 경우(CORS 등) 전체 이미지를 그대로 사용한다.
    return fallback;
  }

  const luminance = new Float32Array(sampleWidth * sampleHeight);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luminance[p] = l;
    sum += l;
  }
  const mean = sum / luminance.length;

  let variance = 0;
  for (let p = 0; p < luminance.length; p++) {
    variance += (luminance[p] - mean) ** 2;
  }
  const std = Math.sqrt(variance / luminance.length);

  // 배경이 밝다고 가정하고, 평균보다 충분히 어두운 픽셀을 "잉크"로 간주한다.
  const threshold = Math.min(235, Math.max(140, mean - std * 0.6));

  const rowDensity = new Float32Array(sampleHeight);
  const colDensity = new Float32Array(sampleWidth);

  for (let y = 0; y < sampleHeight; y++) {
    for (let x = 0; x < sampleWidth; x++) {
      const l = luminance[y * sampleWidth + x];
      if (l < threshold) {
        rowDensity[y] += 1;
        colDensity[x] += 1;
      }
    }
  }

  const rowThreshold = sampleWidth * 0.008;
  const colThreshold = sampleHeight * 0.008;

  const contentRows = findFirstLastAboveThreshold(rowDensity, rowThreshold);
  const contentCols = findFirstLastAboveThreshold(colDensity, colThreshold);

  if (!contentRows || !contentCols) return fallback;

  const [top, bottom] = contentRows;
  const [left, right] = contentCols;

  // 텍스트가 잘리지 않도록 여백을 추가한다.
  const paddingX = (right - left) * 0.06 + sampleWidth * 0.015;
  const paddingY = (bottom - top) * 0.08 + sampleHeight * 0.015;

  const sx = Math.max(0, left - paddingX);
  const sy = Math.max(0, top - paddingY);
  const ex = Math.min(sampleWidth, right + paddingX);
  const ey = Math.min(sampleHeight, bottom + paddingY);

  const inverseScale = 1 / scale;
  const rect: CropRect = {
    x: Math.round(sx * inverseScale),
    y: Math.round(sy * inverseScale),
    width: Math.round((ex - sx) * inverseScale),
    height: Math.round((ey - sy) * inverseScale),
  };

  if (rect.width < 20 || rect.height < 20) return fallback;

  return rect;
}

function findFirstLastAboveThreshold(
  density: Float32Array,
  threshold: number,
): [number, number] | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < density.length; i++) {
    if (density[i] > threshold) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  return [first, last];
}
