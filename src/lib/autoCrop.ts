"use client";

import { detectContentRegion } from "./autoDetectRegion";
import { inkMapFromImage, snapBoxes } from "./snapBoxes";
import type { Region } from "./polygon";

/** luna 자리를 글자에 맞춰 다듬은 뒤 두르는 여유(사방). 딱 맞게 자르면 획 끝이 잘릴 수 있다. */
export const AI_PAD = 0.006;

/**
 * luna 가 잡은 자리(사진 대비 비율)를 사진의 글자에 맞춰 다듬는다(`snapBoxes` — 지면 통째로 넣기와 같은 판단, 모델
 * 테두리는 1~2% 어긋난다). 자르기 화면과 "남은 사진 한 번에 넣기"가 같은 함수를 쓴다 — 보이는 것과 잘리는 것이 같아야 한다.
 */
export function refineAiBox(img: HTMLImageElement | ImageBitmap, box: Region, width: number, height: number): Region {
  let b = { x: box.x, y: box.y, w: box.w, h: box.h };
  const map = inkMapFromImage(img, width, height);
  if (map) b = snapBoxes(map, [b]).boxes[0] ?? b;
  const x0 = Math.max(0, b.x - AI_PAD);
  const y0 = Math.max(0, b.y - AI_PAD);
  const x1 = Math.min(1, b.x + b.w + AI_PAD);
  const y1 = Math.min(1, b.y + b.h + AI_PAD);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** luna 자리가 있으면 다듬어 쓰고, 없으면 브라우저 계산(`detectContentRegion`). */
export function regionForImage(img: HTMLImageElement, box: Region | null | undefined): Region {
  if (box) return refineAiBox(img, box, img.naturalWidth, img.naturalHeight);
  const rect = detectContentRegion(img);
  return {
    x: rect.x / img.naturalWidth,
    y: rect.y / img.naturalHeight,
    w: rect.width / img.naturalWidth,
    h: rect.height / img.naturalHeight,
  };
}
