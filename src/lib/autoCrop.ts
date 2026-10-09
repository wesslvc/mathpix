"use client";

import { detectContentRegion } from "./autoDetectRegion";
import { inkMapFromImage, snapBoxes } from "./snapBoxes";
import type { Region } from "./polygon";

/** luna 자리를 글자에 맞춰 다듬은 뒤 두르는 여유(사방). 딱 맞게 자르면 획 끝이 잘릴 수 있다. */
export const AI_PAD = 0.006;

/** luna 가 짚은 번호·선지 자리 둘레에 두르는 여유(사방, 사진 대비). */
const KEEP_PAD = 0.012;

/**
 * luna 가 잡은 자리(사진 대비 비율)를 사진의 글자에 맞춰 다듬는다(`snapBoxes` — 지면 통째로 넣기와 같은 판단, 모델
 * 테두리는 1~2% 어긋난다). 자르기 화면과 "남은 사진 한 번에 넣기"가 같은 함수를 쓴다 — 보이는 것과 잘리는 것이 같아야 한다.
 */
export function refineAiBox(img: HTMLImageElement | ImageBitmap, box: Region, width: number, height: number): Region {
  let b = { x: box.x, y: box.y, w: box.w, h: box.h };
  const map = inkMapFromImage(img, width, height);
  if (map) b = snapBoxes(map, [b]).boxes[0] ?? b;
  let x0 = Math.max(0, b.x - AI_PAD);
  let y0 = Math.max(0, b.y - AI_PAD);
  let x1 = Math.min(1, b.x + b.w + AI_PAD);
  let y1 = Math.min(1, b.y + b.h + AI_PAD);
  // luna 가 짚은 번호·선지(`keep`)는 다듬은 뒤에도 반드시 품는다 — 글자에 맞춰 줄이다가 끝 선지 줄을 "바깥 것"으로 보고
  // 잘라 내는 일이 있었다. 모델 좌표는 1~2% 어긋나므로 넉넉히(KEEP_PAD) 두른다.
  const keep = (box as Region & { keep?: Region[] }).keep;
  if (Array.isArray(keep)) {
    for (const k of keep) {
      x0 = Math.max(0, Math.min(x0, k.x - KEEP_PAD));
      y0 = Math.max(0, Math.min(y0, k.y - KEEP_PAD));
      x1 = Math.min(1, Math.max(x1, k.x + k.w + KEEP_PAD));
      y1 = Math.min(1, Math.max(y1, k.y + k.h + KEEP_PAD));
    }
  }
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

/**
 * 사진 대비 자리를 사진과 함께 **시계 방향으로 90° × turns** 돌린다(`rotateImageDataUrl` 과 같은 방향). luna 는 돌리기 전 사진에서
 * 자리를 짚으므로, 자르기 화면이 사진을 똑바로 세우면 자리도 같이 돌려야 한다. 짚은 번호·선지(`keep`)도 함께 돌린다.
 */
export function rotateRegion<T extends Region & { keep?: Region[] }>(box: T, turns: number): T {
  const t = ((Math.round(turns) % 4) + 4) % 4;
  const once = (b: Region): Region => ({ x: 1 - (b.y + b.h), y: b.x, w: b.h, h: b.w });
  let out: Region = { x: box.x, y: box.y, w: box.w, h: box.h };
  let keep = box.keep;
  for (let i = 0; i < t; i++) {
    out = once(out);
    keep = keep?.map(once);
  }
  return { ...box, ...out, poly: undefined, ...(keep ? { keep } : {}) } as T;
}
