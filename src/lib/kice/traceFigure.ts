/**
 * 그림(도식)을 **벡터로 따낸다** — 스캔한 선화를 그레이 → marching squares 로 윤곽선을 뽑아 채움 경로(짝홀 규칙)로 돌려준다.
 * 손으로 곡선을 짓지 않으므로 원본과 같은 모양(점선·굵은 선·무늬·글자 모양까지)이 확대해도 선명하게 나온다.
 * 입력은 그레이 픽셀(0=검정, 255=흰색)이고 DOM 이 필요 없다.
 */
import { contourLines, type Poly } from "./contourField";

export type TracedFigure = { w: number; h: number; paths: Poly[] };

/** Douglas–Peucker 로 점을 줄인다(`tol` 은 픽셀). */
function simplify(p: Poly, tol: number): Poly {
  if (p.length < 3) return p;
  // 닫힌 곡선은 처음·끝이 같은 점이라 그대로는 한 점으로 무너진다 — 가장 먼 점에서 둘로 나눠 각각 줄인다.
  const f0 = p[0];
  const fl = p[p.length - 1];
  if (Math.abs(f0[0] - fl[0]) < 1e-9 && Math.abs(f0[1] - fl[1]) < 1e-9 && p.length > 4) {
    let m = 1;
    let best = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const d = Math.hypot(p[i][0] - f0[0], p[i][1] - f0[1]);
      if (d > best) { best = d; m = i; }
    }
    const a = simplifyOpen(p.slice(0, m + 1), tol);
    const b = simplifyOpen(p.slice(m), tol);
    return [...a, ...b.slice(1)];
  }
  return simplifyOpen(p, tol);
}

function simplifyOpen(p: Poly, tol: number): Poly {
  if (p.length < 3) return p;
  const keep = new Array(p.length).fill(false);
  keep[0] = keep[p.length - 1] = true;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let dmax = 0;
    let idx = -1;
    const [ax, ay] = p[a];
    const [bx, by] = p[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((p[i][0] - ax) * dy - (p[i][1] - ay) * dx) / len;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol && idx > 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/**
 * `gray`(폭 w × 높이 h, 행 우선)에서 어두운 부분의 윤곽을 딴다. 좌표는 **픽셀 단위**(왼쪽 위 원점)로 돌려준다.
 * `threshold` 는 0~255(이보다 어두우면 잉크), `blur` 는 계단을 줄이려는 3×3 평균 횟수.
 */
export function traceFigure(gray: Uint8Array, w: number, h: number, opts: { threshold?: number; blur?: number; tol?: number } = {}): TracedFigure {
  const th = opts.threshold ?? 140;
  // 가장자리에 흰 테두리 한 줄을 둘러 모든 윤곽이 닫히게 한다(잉크가 그림 끝에 닿아도 열린 선이 안 생긴다).
  const W0 = w;
  const H0 = h;
  w += 2;
  h += 2;
  let cur = new Float32Array(w * h);
  for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) cur[(y + 1) * w + x + 1] = (255 - gray[y * W0 + x]) / 255;
  for (let n = 0; n < (opts.blur ?? 1); n++) {
    const nx = new Float32Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += cur[yy * w + xx];
          c++;
        }
        nx[y * w + x] = s / c;
      }
    }
    cur = nx;
  }
  const level = (255 - th) / 255;
  // contourLines 는 u,v ∈ [0,1] 격자 nx×ny 를 쓴다 — 격자 점 = 픽셀 중심.
  const f = (u: number, v: number) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
    const y = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
    return cur[y * w + x];
  };
  const lines = contourLines(f, level, w - 1, h - 1);
  const paths = lines.map((l) => simplify(l.map(([u, v]) => [u * (w - 1) - 1, v * (h - 1) - 1] as [number, number]), opts.tol ?? 0.35));
  return { w: W0, h: H0, paths };
}

export type TracedLayers = { w: number; h: number; layers: { gray: number; paths: Poly[] }[] };

/**
 * 회색 음영이 있는 도식용 — 밝은 층부터 어두운 층까지 문턱값마다 윤곽을 따서(`th`보다 어두운 영역), 층마다 그 회색(`gray` 0~1)으로
 * 칠하도록 돌려준다. 밝은 층을 먼저 칠하고 어두운 층을 덮으면 경계에 헤일로가 생기지 않는다.
 */
export function traceLayers(
  gray: Uint8Array,
  w: number,
  h: number,
  layers: { th: number; gray: number }[],
  opts: { blur?: number; tol?: number } = {},
): TracedLayers {
  const sorted = [...layers].sort((a, b) => b.th - a.th);
  return {
    w,
    h,
    layers: sorted.map((l) => ({ gray: l.gray, paths: traceFigure(gray, w, h, { threshold: l.th, blur: opts.blur, tol: opts.tol }).paths })),
  };
}
