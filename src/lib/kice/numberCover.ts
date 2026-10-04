// **문제 그림에서 원래 번호가 찍힌 자리를 찾는다**(2026-10-04, 사용자 — "여러 개로 묶으면 1번부터 번호를 새로 써,
// 원래 번호 있던 자리에 번호를 덮어 버리는 거지"). 브라우저 전용(캔버스로 픽셀을 본다).
//
// 문제 그림은 둘 중 하나다 — 우리가 조판한 카드(맨 앞 문단이 굵은 "17." 로 시작) 아니면 통째로 다시 그린/오려 낸
// 문제 그림(역시 번호가 왼쪽 위에 먼저 온다). 그래서 **첫 글자 줄의 첫 덩어리**를 번호로 본다:
//   ① 위에서부터 잉크가 있는 첫 줄(왼쪽 60% 안)을 찾아 그 줄의 위아래 끝을 잰다.
//   ② 그 줄에서 왼쪽부터 잉크를 따라가다 **띄어쓰기만큼 빈 틈**(줄 높이의 28%)이 나오면 거기까지가 번호다.
//   ③ 모양을 확인한다 — 왼쪽 25% 안에서 시작하고, 폭이 그 자릿수에 맞아야 한다(번호가 아닌 낱말을 덮으면 안 된다).
// 못 찾으면 null — 부르는 쪽이 그 문제는 번호를 안 바꾸고 알린다(엉뚱한 글자를 덮는 것보다 낫다).

export type NumberBox = {
  /** 그림 대비 비율(0~1). 덮을 네모(여유 포함). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 원래 글자 줄의 아래 끝(그림 대비, 0~1) — 새 번호의 글자 줄을 여기에 맞춘다. */
  base: number;
  /** 원래 글자 줄 높이(그림 대비, 0~1). 새 번호 글자 크기를 여기서 정한다. */
  line: number;
};

const SCAN_W = 900;

async function grayOf(png: Uint8Array): Promise<{ g: Uint8ClampedArray; w: number; h: number }> {
  const bmp = await createImageBitmap(new Blob([png.slice().buffer], { type: "image/png" }));
  const k = Math.min(1, SCAN_W / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return { g, w, h };
}

/** 픽셀 밝기 배열에서 번호 자리를 찾는다(테스트하기 쉽게 따로 둔다). `digits` = 원래 번호의 자릿수(모르면 3). */
export function findNumberBoxIn(g: ArrayLike<number>, w: number, h: number, digits = 3): NumberBox | null {
  const INK = 130;
  const ink = (x: number, y: number) => g[y * w + x] < INK;
  const scanR = Math.round(w * 0.6);
  const rowInk = (y: number) => {
    let n = 0;
    for (let x = 0; x < scanR; x++) if (ink(x, y)) n++;
    return n;
  };
  // ① 첫 글자 줄. 잡티(한두 점)는 건너뛴다.
  const minRow = Math.max(2, Math.round(w * 0.002));
  let y0 = -1;
  // 그림 위쪽 40% 안에서 찾되, 한두 줄짜리 짧은 그림은 위 여백만으로 40% 를 넘으므로 폭의 30% 까지는 본다.
  for (let y = 0; y < Math.min(h, Math.round(Math.max(h * 0.4, w * 0.3))); y++) {
    if (rowInk(y) >= minRow) {
      y0 = y;
      break;
    }
  }
  if (y0 < 0) return null;
  let y1 = y0;
  while (y1 + 1 < h && rowInk(y1 + 1) > 0) y1++;
  const lineH = y1 - y0 + 1;
  if (lineH < w * 0.008 || lineH > w * 0.12) return null;

  // ② 그 줄을 글자 덩어리로 가른다(빈 세로줄에서 끊는다). 덩어리마다 잉크의 위아래도 잰다.
  const colInk = (x: number) => {
    for (let y = y0; y <= y1; y++) if (ink(x, y)) return true;
    return false;
  };
  type Blob = { x0: number; x1: number; top: number; bot: number };
  const blobs: Blob[] = [];
  for (let x = 0; x < w && blobs.length < 12; x++) {
    if (!colInk(x)) continue;
    const bx0 = x;
    while (x + 1 < w && colInk(x + 1)) x++;
    let top = y1;
    let bot = y0;
    for (let y = y0; y <= y1; y++) {
      for (let xx = bx0; xx <= x; xx++) {
        if (ink(xx, y)) {
          if (y < top) top = y;
          if (y > bot) bot = y;
          break;
        }
      }
    }
    blobs.push({ x0: bx0, x1: x, top, bot });
  }
  if (!blobs.length || blobs[0].x0 > w * 0.25) return null;
  const x0 = blobs[0].x0;
  // 번호는 마침표에서 끝난다 — **마침표**(작고 줄 아래쪽에 붙은 점)가 숫자 덩어리 뒤 몇 칸 안에 나오면 거기까지.
  // 숫자 '1' 은 양옆이 많이 비어 있어 "빈 틈 = 띄어쓰기"로 자르면 112 가 1 에서 끊긴다(시험에서 그랬다).
  const isDot = (b: Blob) => b.bot - b.top + 1 <= lineH * 0.3 && b.top > y0 + lineH * 0.5;
  let end = -1;
  for (let i = 1; i < Math.min(blobs.length, digits + 3); i++) {
    if (isDot(blobs[i])) {
      end = i;
      break;
    }
    if (blobs[i].bot - blobs[i].top + 1 < lineH * 0.4) break; // 숫자가 아닌 작은 것 — 마침표 찾기를 그만둔다
  }
  if (end < 0) {
    // 마침표가 없는 번호(05 윗글을…) — 띄어쓰기만큼 빈 틈에서 끊는다.
    const gapNeed = Math.max(2, Math.round(lineH * 0.28));
    end = 0;
    while (end + 1 < blobs.length && blobs[end + 1].x0 - blobs[end].x1 - 1 < gapNeed) end++;
  }
  // 숫자답지 않으면 번호가 아니다 — 앞 글자를 숫자로 잘못 보고 덮으면 문제 글이 지워진다. 숫자는 한글 음절보다 좁고
  // (줄 높이의 72% 아래), 키가 크고(60% 넘게), **서로 키가 같다**(±15%). 한글 음절이 자모로 쪼개진 덩어리
  // (ㅇ·ㅣ, ㄱ·ㅏ)는 키가 서로 달라 여기서 걸러진다.
  const digitBlobs = blobs.slice(0, end + 1).filter((b) => !isDot(b));
  if (!digitBlobs.length || digitBlobs.length > digits + 1) return null;
  const heights = digitBlobs.map((b) => b.bot - b.top + 1);
  const hiH = Math.max(...heights);
  const loH = Math.min(...heights);
  if (hiH < lineH * 0.6 || loH < hiH * 0.85) return null;
  if (digitBlobs.some((b) => b.x1 - b.x0 + 1 > lineH * 0.72)) return null;
  const x1 = blobs[end].x1;
  const cw = x1 - x0 + 1;
  // ③ 번호다운가 — 자릿수 + 마침표 폭 안쪽이어야 한다. 너무 가늘면(세로줄·괄호 하나) 번호가 아니다.
  if (cw > (digits + 1) * 0.8 * lineH || cw < lineH * 0.25) return null;
  // 덮는 높이는 번호에 맞춘다(줄의 다른 글자가 더 클 수 있다).
  const cy0 = Math.min(...blobs.slice(0, end + 1).map((b) => b.top));
  const cy1 = Math.max(...blobs.slice(0, end + 1).map((b) => b.bot));
  const pad = Math.max(1, Math.round(lineH * 0.12));
  const bx0 = Math.max(0, x0 - pad);
  const by0 = Math.max(0, Math.min(cy0, y0) - pad);
  const bx1 = Math.min(w - 1, x1 + pad);
  const by1 = Math.min(h - 1, Math.max(cy1, y1) + pad);
  return {
    x: bx0 / w,
    y: by0 / h,
    w: (bx1 - bx0 + 1) / w,
    h: (by1 - by0 + 1) / h,
    base: (cy1 + 1) / h,
    line: (cy1 - cy0 + 1) / h,
  };
}

/** 문제 그림(PNG)에서 원래 번호 자리. 못 찾으면 null. */
export async function findNumberBox(png: Uint8Array, digits?: number): Promise<NumberBox | null> {
  try {
    const { g, w, h } = await grayOf(png);
    return findNumberBoxIn(g, w, h, digits);
  } catch {
    return null;
  }
}
