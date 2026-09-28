/**
 * 손으로 자를 때 쓰는 **다각형 영역**.
 *
 * 사용자 요청(2026-09-28) — "이미지 자를 때 다각형으로 자를 수 있게, 사람이
 * 손으로 할 때 얘기야(기본은 사각형인데 설정 가능하게)". 시험지 지면에서는
 * 문제 영역이 네모가 아닌 일이 흔하다 — 옆 문제의 그림이 한쪽 귀퉁이를 파고들어
 * 있거나, 한 단 안에서 앞 문제의 선지 끝줄이 걸쳐 있으면 네모로는 그걸 빼고
 * 자를 수가 없다.
 *
 * **다각형도 늘 네모(`x,y,w,h`)를 함께 든다** — 다각형을 감싸는 네모다. 그래서
 * 자리를 다루는 나머지 코드(정렬·단 가르기·합치기·지문 안 그림의 폭 비율)는
 * 전부 예전 그대로 네모를 보고, **자를 때만** 다각형 바깥을 흰색으로 지운다.
 *
 * 좌표는 전부 사진 크기 대비 비율(0~1)이다. 이 파일에는 네트워크 호출도
 * 환경변수도 없다(화면 전용 유틸이다 — 캔버스를 쓰는 함수만 브라우저에서 돈다).
 */

import { cropImageToDataUrl } from "./cropImage";

export type Pt = { x: number; y: number };

/** 다각형을 가질 수 있는 영역. `poly` 가 없으면 그냥 네모다. */
export type Region = { x: number; y: number; w: number; h: number; poly?: Pt[] };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 다각형을 감싸는 네모. */
export function polyBounds(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** 네모의 네 귀퉁이(왼쪽 위부터 시계 방향). */
export function rectPoly(b: { x: number; y: number; w: number; h: number }): Pt[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

/** 점들을 사진 안으로 넣고 감싸는 네모를 다시 맞춘 영역을 만든다. */
export function regionFromPoly<T extends object>(base: T, pts: Pt[]): T & Region {
  const poly = pts.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
  return { ...base, ...polyBounds(poly), poly };
}

/**
 * 다각형이 **실제로 네모와 다른가**. 네 점이 네모의 귀퉁이 그대로면 굳이 가리지
 * 않는다(흰색 칠하기 한 번이 더 드는 것뿐 아니라, 안티에일리어싱으로 가장자리에
 * 옅은 선이 생길 수 있다).
 */
export function isRealPolygon(r: Region): r is Region & { poly: Pt[] } {
  const p = r.poly;
  if (!p || p.length < 3) return false;
  if (p.length !== 4) return true;
  const eps = 1e-6;
  const xs = new Set(p.map((q) => Math.round(q.x / eps)));
  const ys = new Set(p.map((q) => Math.round(q.y / eps)));
  // 축에 나란한 네모면 x 값도 y 값도 두 가지뿐이다.
  return !(xs.size === 2 && ys.size === 2);
}

/** 점 하나가 다각형 안에 있는가(짝홀 규칙). */
export function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

const JPEG_QUALITY = 0.9;

/**
 * 영역 하나를 원본에서 잘라 data URL 로 돌려준다. **다각형이면 바깥을 흰색으로
 * 지운다** — 종이가 흰색이라 지운 자리가 티 나지 않고, 투명으로 두면 JPEG 에서
 * 검게 나온다(JPEG 에는 투명이 없다).
 *
 * `pad` 는 자동으로 찾은 네모에만 주는 여유다(손으로 그린 것은 0). 다각형은
 * 손으로만 그리므로 여유를 주지 않는다 — 준다면 다각형 자체를 부풀려야 하는데,
 * 사용자가 정한 선을 몰래 넓히는 것이라 하지 않는다.
 *
 * 크기 제한(`limits`)은 `cropImageToDataUrl` 과 같다 — 없으면 긴 변 1600px.
 */
export function cropRegionToDataUrl(
  image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  region: Region,
  pad = 0,
  limits?: { maxWidth: number; maxHeight: number },
): string {
  const W = (image as HTMLImageElement).naturalWidth || (image as ImageBitmap).width;
  const H = (image as HTMLImageElement).naturalHeight || (image as ImageBitmap).height;

  if (!isRealPolygon(region)) {
    const x = Math.max(0, region.x - pad);
    const y = Math.max(0, region.y - pad);
    const w = Math.min(1 - x, region.w + pad * 2);
    const h = Math.min(1 - y, region.h + pad * 2);
    return cropImageToDataUrl(image, { x: x * W, y: y * H, width: w * W, height: h * H }, limits);
  }

  const b = polyBounds(region.poly);
  const sx = b.x * W;
  const sy = b.y * H;
  const sw = Math.max(1, b.w * W);
  const sh = Math.max(1, b.h * H);
  const scale = limits
    ? Math.min(1, limits.maxWidth / sw, limits.maxHeight / sh)
    : Math.min(1, 1600 / Math.max(sw, sh));
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  ctx.save();
  ctx.beginPath();
  region.poly.forEach((p, i) => {
    const px = ((p.x * W - sx) / sw) * outW;
    const py = ((p.y * H - sy) / sh) * outH;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outW, outH);
  ctx.restore();
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
