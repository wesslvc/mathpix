import { cropImageToDataUrl, loadImage } from "./cropImage";
import { enhanceContrast } from "./autoContrast";
import { DETECT_INPUT_DIM, MAX_UPLOAD_CHARS } from "./figureImage";

/**
 * OMR·정답표 사진을 채점 모델에 보낼 크기로 줄인다.
 *
 * OMR의 마킹, 정답표의 작은 숫자는 지면 전체에서 아주 작은 자리를 차지하므로
 * `detectImage`(문제 영역 찾기)와 같은 이유로 **되도록 크게** 보내되, 요청
 * 본문 상한(Vercel 4.5MB)에 걸리지 않게 실제 길이를 보고 한 단씩 낮춘다.
 *
 * 채점 한 번에 사진이 여러 장(탐구는 3장)일 수 있어 **장당 예산을 나눈다** —
 * 한 장 기준 상한(`MAX_UPLOAD_CHARS`)을 그대로 여러 장에 쓰면 요청이 통째로
 * 실패한다.
 */
export async function prepareGradingImage(
  file: File,
  budgetChars: number,
): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const whole = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    let last = "";
    for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
      last = cropImageToDataUrl(img, whole, { maxWidth: dim, maxHeight: dim });
      if (last.length <= budgetChars) break;
    }
    // 대비를 올리면 흐린 필기·옅은 마킹이 또렷해진다. 크기를 맞춘 뒤에 한다
    // (전에 하면 늘린 값이 다시 뭉개진다).
    const enhanced = await enhanceContrast(last);
    return enhanced.length <= budgetChars ? enhanced : last;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 이번 요청에 쓸 이미지 장수로 전체 예산을 나눈다. */
export function gradingImageBudget(imageCount: number): number {
  return Math.floor(MAX_UPLOAD_CHARS / Math.max(1, imageCount));
}
