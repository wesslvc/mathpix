import type { ProblemBox } from "./problemBoxes";

/**
 * **모델이 잡은 자리의 테두리를 사진의 글자에 맞춰 다듬는다**(2026-10-02, 사용자 — "자르는 거 좀 더 정확하게").
 *
 * 영역 찾기(luna)는 **어느 문제가 어디쯤인지**는 잘 알지만 테두리는 1~2% 어긋난다 — 비전 모델이 지면을 짧은 변
 * 768px 쯤으로 줄여 보기 때문이다. 3000px 지면이면 30~60px, 글자 한두 줄이다. 그래서 마지막 선지 줄이 잘리거나
 * 옆 문제의 빈 줄이 딸려 왔다. 시험지는 문제 사이가 늘 흰 띠라 **어디서 자를지는 픽셀이 더 정확히 안다** — 모델이
 * 준 네모를 출발점으로 삼아 변마다 가까운 흰 띠에 붙인다. 모델 호출은 늘지 않는다.
 *
 * 규칙(전부 "모델이 준 자리 가까이에서만" — 창 밖으로는 안 간다):
 * - **변이 글자 줄을 가로지르면** 그 줄이 네모 안쪽에 더 많이 걸쳤을 때만 넓혀 품고, 바깥쪽에 더 걸쳤으면 이웃 것이라
 *   보고 줄 다음 흰 띠까지 줄인다.
 * - **변이 빈 곳에 있으면** 안쪽 첫 글자까지 줄인다(남는 여백 없애기).
 * - **바깥에 줄 간격만큼만 떨어진 글자 줄**은 같은 덩어리로 보고 품는다(선지 한 줄을 놓친 경우) — 다만 두 줄까지,
 *   네모 안 줄 간격의 1.25배 이내일 때만. 문제 사이 간격은 그보다 넓다.
 * - **다른 네모(이웃 문제·지문)의 원래 자리는 넘지 않는다.**
 * - 지면을 가로·세로로 가르는 **구분선**(단 구분선·머리말 아래 줄)은 글자로 치지 않는다 — 안 그러면 테두리가 구분선에
 *   붙는다.
 *
 * 이 파일은 순수 함수다(캔버스에서 읽는 것은 `inkMapFromImage` 하나). 좌표는 0~1 비율.
 */

export type InkMap = { ink: Uint8Array; w: number; h: number };

/** RGBA 바이트에서 잉크 지도를 만든다. 밝기 기준은 칸마다 따로 잡는다(조명 기울기를 견딘다 — autoDetectRegion 과 같은 판단). */
export function inkFromRgba(data: Uint8ClampedArray | Uint8Array, w: number, h: number): InkMap {
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const ink = new Uint8Array(w * h);
  const block = Math.max(24, Math.round(Math.min(w, h) / 24));
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const xb = Math.min(w, bx + block);
      const yb = Math.min(h, by + block);
      let sum = 0;
      let n = 0;
      for (let y = by; y < yb; y++) for (let x = bx; x < xb; x++) { sum += lum[y * w + x]; n++; }
      const mean = n ? sum / n : 255;
      // 평균보다 밝은 쪽만 다시 평균 — 이 칸의 "종이" 밝기.
      let bright = 0;
      let bn = 0;
      for (let y = by; y < yb; y++) {
        for (let x = bx; x < xb; x++) {
          const v = lum[y * w + x];
          if (v >= mean) { bright += v; bn++; }
        }
      }
      const paper = bn ? bright / bn : mean;
      const cut = paper - Math.max(paper * 0.18, 26);
      for (let y = by; y < yb; y++) for (let x = bx; x < xb; x++) if (lum[y * w + x] < cut) ink[y * w + x] = 1;
    }
  }
  clearRules(ink, w, h);
  return { ink, w, h };
}

/**
 * 지면을 가로지르는 구분선을 지운다. 단 구분선은 지면 높이의 60% 넘게, 머리말 아래 줄은 폭의 75% 넘게 이어진다 —
 * 문제 안의 조건 박스 테두리는 그만큼 길지 않다.
 */
function clearRules(ink: Uint8Array, w: number, h: number) {
  const ruleCols: number[] = [];
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) n += ink[y * w + x];
    if (n >= h * 0.6) ruleCols.push(x);
  }
  const ruleRows: number[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += ink[y * w + x];
    if (n >= w * 0.75) ruleRows.push(y);
  }
  for (const x of ruleCols) for (let y = 0; y < h; y++) ink[y * w + x] = 0;
  for (const y of ruleRows) ink.fill(0, y * w, y * w + w);
}

/** 그림을 줄여 그려 잉크 지도를 만든다(브라우저). 못 읽으면 null — 그때는 다듬지 않는다. */
export function inkMapFromImage(
  img: HTMLImageElement | ImageBitmap,
  width: number,
  height: number,
  // 줄이면 '1'·'l' 같은 가는 획이 흐려져 잉크에서 빠진다 — 영역 찾기에 보내는 크기(3000)와 맞춘다.
  maxDim = 3000,
): InkMap | null {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return inkFromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}

type Px = { x0: number; y0: number; x1: number; y1: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 네모들의 테두리를 다듬는다. `obstacles` 는 넘지 말아야 할 다른 네모(예: 문제를 다듬을 때의 지문 자리).
 * 돌려주는 배열은 들어온 차례 그대로이고, 다듬을 수 없는 것은 그대로 돌려준다.
 */
export function snapBoxes(
  map: InkMap,
  boxes: ProblemBox[],
  obstacles: ProblemBox[] = [],
): { boxes: ProblemBox[]; changed: number } {
  const { w: W, h: H } = map;
  const toPx = (b: ProblemBox): Px => ({
    x0: clamp(Math.round(b.x * W), 0, W - 1),
    y0: clamp(Math.round(b.y * H), 0, H - 1),
    x1: clamp(Math.round((b.x + b.w) * W) - 1, 0, W - 1),
    y1: clamp(Math.round((b.y + b.h) * H) - 1, 0, H - 1),
  });
  const originals = separateOverlaps(map, boxes.map(toPx));
  const blocks = obstacles.map(toPx);
  let changed = 0;
  const out = boxes.map((b, i) => {
    const others = [...originals.filter((_, j) => j !== i), ...blocks];
    const p = originals[i];
    if (p.x1 - p.x0 < 8 || p.y1 - p.y0 < 8) return b;
    let q = snapVertical(map, p, others);
    q = snapHorizontal(map, q, others);
    q = snapVertical(map, q, others);
    if (q.x1 - q.x0 < 8 || q.y1 - q.y0 < 8) return b;
    const next = { x: q.x0 / W, y: q.y0 / H, w: (q.x1 + 1 - q.x0) / W, h: (q.y1 + 1 - q.y0) / H };
    if (Math.abs(next.x - b.x) + Math.abs(next.y - b.y) + Math.abs(next.w - b.w) + Math.abs(next.h - b.h) > 0.002) {
      changed++;
    }
    return next;
  });
  return { boxes: out, changed };
}

/**
 * **겹친 네모는 그 사이 가장 넓은 흰 띠에서 가른다.** 모델이 위 문제를 다음 문제 첫 줄까지 늘려 잡으면 두 네모가
 * 겹치는데, 변 하나만 보고는 그 줄이 누구 것인지 모른다(줄 한가운데가 아니라 줄 사이 빈 곳에 변이 놓이면 더 그렇다).
 * 문제 사이 간격은 줄 간격보다 넓으므로 겹친 자리 근처에서 가장 넓은 흰 띠가 곧 경계다. 좌우로 겹친 것도 같은 식이다.
 */
function separateOverlaps(map: InkMap, boxes: Px[]): Px[] {
  const { ink, w: W, h: H } = map;
  const out = boxes.map((b) => ({ ...b }));
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      const ox = overlapLen(a.x0, a.x1, b.x0, b.x1);
      const oy = overlapLen(a.y0, a.y1, b.y0, b.y1);
      if (!ox || !oy) continue;
      const wideX = ox >= Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.3;
      const wideY = oy >= Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.3;
      if (wideX && oy < ox) {
        // 위아래로 겹쳤다.
        const [up, dn] = a.y0 + a.y1 <= b.y0 + b.y1 ? [a, b] : [b, a];
        const xs0 = Math.max(up.x0, dn.x0);
        const xs1 = Math.min(up.x1, dn.x1);
        const tol = Math.max(3, Math.round((xs1 - xs0 + 1) * 0.008));
        const win = Math.round(H * 0.04);
        const cut = widestBlank(
          (y) => {
            let n = 0;
            for (let x = xs0; x <= xs1; x++) n += ink[y * W + x];
            return n <= tol;
          },
          Math.max(up.y0 + 8, dn.y0 - win),
          Math.min(dn.y1 - 8, up.y1 + win),
        );
        if (cut) {
          up.y1 = Math.min(up.y1, cut[0] - 1);
          dn.y0 = Math.max(dn.y0, cut[1] + 1);
        }
      } else if (wideY && ox <= oy) {
        // 좌우로 겹쳤다.
        const [lf, rt] = a.x0 + a.x1 <= b.x0 + b.x1 ? [a, b] : [b, a];
        const ys0 = Math.max(lf.y0, rt.y0);
        const ys1 = Math.min(lf.y1, rt.y1);
        const tol = Math.max(3, Math.round((ys1 - ys0 + 1) * 0.008));
        const win = Math.round(W * 0.03);
        const cut = widestBlank(
          (x) => {
            let n = 0;
            for (let y = ys0; y <= ys1; y++) n += ink[y * W + x];
            return n <= tol;
          },
          Math.max(lf.x0 + 8, rt.x0 - win),
          Math.min(rt.x1 - 8, lf.x1 + win),
        );
        if (cut) {
          lf.x1 = Math.min(lf.x1, cut[0] - 1);
          rt.x0 = Math.max(rt.x0, cut[1] + 1);
        }
      }
    }
  }
  return out;
}

/** [lo, hi] 안에서 가장 넓은 흰 띠(두 줄 이상). 없으면 null. */
function widestBlank(blank: (i: number) => boolean, lo: number, hi: number): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  for (let i = lo; i <= hi + 1; i++) {
    if (i <= hi && blank(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 2 && (!best || i - start > best[1] - best[0] + 1)) best = [start, i - 1];
      start = -1;
    }
  }
  return best;
}

const overlapLen = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1);

/** 위아래 변. 가로 범위는 그 네모의 폭이다. */
function snapVertical(map: InkMap, p: Px, others: Px[]): Px {
  const { ink, w: W, h: H } = map;
  const win = Math.round(H * 0.04);
  const width = p.x1 - p.x0 + 1;
  const tol = Math.max(3, Math.round(width * 0.008));
  const rowInk = (y: number) => {
    let n = 0;
    const base = y * W;
    for (let x = p.x0; x <= p.x1; x++) n += ink[base + x];
    return n;
  };
  const blank = (y: number) => rowInk(y) <= tol;

  // 이웃(가로로 많이 겹치는 다른 네모)의 원래 자리를 넘지 않는다.
  let topLimit = Math.max(0, p.y0 - win);
  let bottomLimit = Math.min(H - 1, p.y1 + win);
  for (const o of others) {
    if (overlapLen(p.x0, p.x1, o.x0, o.x1) < Math.min(width, o.x1 - o.x0 + 1) * 0.3) continue;
    if (o.y1 < p.y0 + (p.y1 - p.y0) / 2 && o.y1 < p.y1) topLimit = Math.max(topLimit, Math.min(o.y1 + 1, p.y0));
    if (o.y0 > p.y0 + (p.y1 - p.y0) / 2 && o.y0 > p.y0) bottomLimit = Math.min(bottomLimit, Math.max(o.y0 - 1, p.y1));
  }

  // 네모 안 글자 줄 사이 간격(가운데값) — 바깥 줄이 "같은 덩어리"인지 가르는 잣대.
  const gaps: number[] = [];
  let inRun = false;
  let gapStart = -1;
  for (let y = p.y0; y <= p.y1; y++) {
    if (!blank(y)) {
      if (!inRun && gapStart >= 0) gaps.push(y - gapStart);
      inRun = true;
    } else if (inRun) {
      inRun = false;
      gapStart = y;
    }
  }
  gaps.sort((a, b) => a - b);
  // 아래쪽 4분의 1 값을 쓴다 — 그림·조건 박스 앞뒤 간격이 섞이면 가운데값이 부풀어 다음 문제 줄까지 품는다.
  const lineGap = gaps.length ? gaps[Math.floor((gaps.length - 1) / 4)] : Math.round(H * 0.008);
  const absorbGap = Math.max(2, Math.round(lineGap * 1.25));

  const top = snapEdge(blank, p.y0, p.y1, -1, topLimit, bottomLimit, absorbGap, H);
  const bottom = snapEdge(blank, p.y1, top, +1, topLimit, bottomLimit, absorbGap, H);
  if (bottom - top < 8) return p;
  return { ...p, y0: top, y1: bottom };
}

/**
 * 한 변(edge)을 다듬는다. `dir` 은 바깥 방향(-1 = 위/왼쪽, +1 = 아래/오른쪽), `inner` 는 반대쪽 변.
 * `lo`/`hi` 는 움직일 수 있는 범위.
 */
function snapEdge(
  blank: (i: number) => boolean,
  edge: number,
  inner: number,
  dir: -1 | 1,
  lo: number,
  hi: number,
  absorbGap: number,
  /** 전체 길이 — 품을 줄 너머의 빈칸은 창·이웃 경계와 상관없이 지면 끝까지 잰다. */
  size: number,
): number {
  const inRange = (i: number) => i >= lo && i <= hi;
  // 줄(글자가 이어진 구간)의 바깥쪽 끝.
  const runEnd = (i: number, d: -1 | 1) => {
    let j = i;
    while (inRange(j + d) && !blank(j + d)) j += d;
    return j;
  };
  let e = edge;
  if (!blank(e)) {
    const outer = runEnd(e, dir);
    const innerEnd = runEnd(e, (-dir) as -1 | 1);
    const outside = Math.abs(outer - e);
    const inside = Math.abs(innerEnd - e) + 1;
    const hitLimit = !inRange(outer + dir);
    if (outside <= inside) {
      // 이 네모의 줄이다 — 넓혀 품는다. 줄이 창 끝까지 이어지면(그림 따위) 어디가 끝인지 모르니 그대로 둔다.
      if (!hitLimit) e = outer;
    } else {
      // 바깥 것(이웃)의 줄이다 — 그 줄 다음 흰 띠를 지나 첫 글자까지 줄인다.
      let j = innerEnd - dir;
      while (j !== inner && blank(j)) j -= dir;
      if (j !== inner) e = j;
    }
  } else {
    // 빈 곳 — 안쪽 첫 글자까지 줄인다.
    let j = e;
    while (j !== inner && blank(j)) j -= dir;
    if (!blank(j)) e = j;
  }
  // 바깥 가까이 있는 글자 줄은 같은 덩어리로 품는다(두 줄까지) — 선지 한 줄을 놓친 경우다. 품는 조건:
  //  ① 줄 간격만큼만 떨어졌거나, ② 줄 간격의 5배 안이면서 **그 줄 너머의 빈칸이 더 넓을 때**(그 줄이 바깥 것보다
  //  우리 쪽에 가깝다). 그림·조건 박스 아래 선지는 ②로 품고, 다음 문제의 첫 줄은 바로 아래 자기 줄과 더 가까워 안 품는다.
  const gapFrom = (start: number, within: (i: number) => boolean) => {
    let j = start;
    let gap = 0;
    while (within(j) && blank(j)) {
      j += dir;
      gap++;
    }
    return { j, gap, open: !within(j) };
  };
  const onPage = (i: number) => i >= 0 && i < size;
  for (let k = 0; k < 2; k++) {
    const { j, gap, open } = gapFrom(e + dir, inRange);
    if (open || gap === 0 || gap > absorbGap * 4) break;
    const outer = runEnd(j, dir);
    if (!inRange(outer + dir)) break;
    const after = gapFrom(outer + dir, onPage);
    const fartherAfter = after.open || after.gap > gap;
    // ②는 아래 변에만 쓴다. 빠지기 쉬운 것은 맨 아래 선지 줄이고, 위 변에서 넓은 간격 너머의 줄은 대개 머리말·앞 문제다
    // (첫 줄을 놓쳤으면 그 줄은 본문과 줄 간격만큼만 떨어져 ①로 품는다).
    if (!(gap <= absorbGap || (dir === 1 && fartherAfter))) break;
    e = outer;
  }
  return e;
}

/** 왼쪽·오른쪽 변. 세로 범위는 그 네모의 높이다. 낱말 사이 띄어쓰기는 흰 띠로 치지 않는다. */
function snapHorizontal(map: InkMap, p: Px, others: Px[]): Px {
  const { ink, w: W } = map;
  const win = Math.round(W * 0.04);
  const height = p.y1 - p.y0 + 1;
  const tol = Math.max(3, Math.round(height * 0.008));
  const colInk = (x: number) => {
    let n = 0;
    for (let y = p.y0; y <= p.y1; y++) n += ink[y * W + x];
    return n;
  };
  const blank = (x: number) => colInk(x) <= tol;
  // 낱말 사이 띄어쓰기(글자 폭의 3분의 1쯤)보다 넓어야 한다 — 단 사이 여백·지면 여백만 걸린다.
  const band = Math.max(6, Math.round(W * 0.012));

  let leftLimit = Math.max(0, p.x0 - win);
  let rightLimit = Math.min(W - 1, p.x1 + win);
  for (const o of others) {
    if (overlapLen(p.y0, p.y1, o.y0, o.y1) < Math.min(height, o.y1 - o.y0 + 1) * 0.3) continue;
    if (o.x1 < p.x0 + (p.x1 - p.x0) / 2 && o.x1 < p.x1) leftLimit = Math.max(leftLimit, Math.min(o.x1 + 1, p.x0));
    if (o.x0 > p.x0 + (p.x1 - p.x0) / 2 && o.x0 > p.x0) rightLimit = Math.min(rightLimit, Math.max(o.x0 - 1, p.x1));
  }

  const side = (edge: number, inner: number, dir: -1 | 1, lo: number, hi: number) => {
    // 변이 낱말 사이 띄어쓰기에 놓였으면(바깥으로 좁은 빈칸 뒤에 곧 글자) 글자를 가로지른 것과 같다.
    let gapOut = 0;
    while (edge + dir * (gapOut + 1) >= lo && edge + dir * (gapOut + 1) <= hi && blank(edge + dir * (gapOut + 1)) && gapOut < band) {
      gapOut++;
    }
    const nextOut = edge + dir * (gapOut + 1);
    const inWordGap = blank(edge) && gapOut < band - 1 && nextOut >= lo && nextOut <= hi && !blank(nextOut);
    if (blank(edge) && !inWordGap) {
      // 빈 곳 — 안쪽 첫 글자까지 줄인다.
      let j = edge;
      while (j !== inner && blank(j)) j -= dir;
      return blank(j) ? edge : j;
    }
    // 글자를 가로지른다 — 바깥으로 넓은 흰 띠(낱말 사이보다 넓은)가 나올 때까지 넓힌다. 못 찾으면 그대로.
    let run = 0;
    let j = edge + dir;
    for (; j >= lo && j <= hi; j += dir) {
      if (blank(j)) {
        run++;
        if (run >= band) return j - dir * run;
      } else run = 0;
    }
    // 창 끝에서 흰 띠가 막 시작됐으면(반 이상) 그 앞까지 — 단 사이 여백이 창 끝에 걸친 경우다.
    if (run >= Math.ceil(band / 2)) return j - dir - dir * run;
    return edge;
  };
  const left = side(p.x0, p.x1, -1, leftLimit, rightLimit);
  const right = side(p.x1, left, +1, leftLimit, rightLimit);
  if (right - left < 8) return p;
  return { ...p, x0: left, x1: right };
}
