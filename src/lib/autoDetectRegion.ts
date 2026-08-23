import type { CropRect } from "./types";

/**
 * 사진에서 "문제가 적힌 자리"를 추정해 크롭 초기값으로 준다.
 * 최종 정확도는 다음 단계에서 사용자가 손으로 보정한다.
 *
 * **두 걸음으로 나눈다 — 종이를 먼저 찾고, 그 안에서 글자를 찾는다.**
 *
 * 예전에는 사진 전체에 대고 "평균보다 어두우면 잉크"라고 한 뒤 그 바깥
 * 경계를 잡았다. 그런데 **손으로 찍은 사진은 종이 바깥의 책상이 글자보다 더
 * 어둡다.** 그러면 그 픽셀이 전부 잉크로 잡혀 경계가 사진 네 귀퉁이까지
 * 벌어진다 — 종이가 화면을 꽉 채우는 스캔본이 아니면 **한 번도 동작할 수 없는**
 * 구조였다. 실제로 그랬다(책상 위 사진·어두운 조명 둘 다 100%×100%).
 *
 * 지금은 ① 밝은 덩어리(종이)의 경계를 먼저 잡고 ② 그 안쪽에서만 글자를 찾는다.
 * 종이가 화면을 꽉 채우면 ①이 화면 전체가 되어 예전과 같은 길로 흐른다.
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

  const sample = toLuminanceSample(image, naturalWidth, naturalHeight);
  if (!sample) return fallback;
  const { lum, w, h } = sample;

  // ① 종이 찾기. 밝은 쪽과 어두운 쪽을 가르는 값을 히스토그램에서 구한다
  //    (Otsu). 책상 위 사진이면 종이/책상이 갈리고, 스캔본이면 종이/글자가
  //    갈려 "밝은 쪽"이 화면 전체가 된다 — 어느 쪽이든 옳게 흐른다.
  const paperCut = otsuThreshold(lum);
  const paper =
    boundsByDensity(lum, w, h, (v) => v >= paperCut, 0.5) ?? [0, 0, w - 1, h - 1];

  // 종이 가장자리의 그림자·접힌 자국이 글자로 잡히지 않게 조금 안쪽부터 본다.
  const inset = Math.round(Math.min(paper[2] - paper[0], paper[3] - paper[1]) * 0.02);
  const px0 = Math.min(paper[0] + inset, paper[2]);
  const py0 = Math.min(paper[1] + inset, paper[3]);
  const px1 = Math.max(paper[2] - inset, px0);
  const py1 = Math.max(paper[3] - inset, py0);

  // ② 종이 안에서 글자 찾기. 밝기 기준을 **자리마다 따로** 잡는다 — 한 장의
  //    사진 안에서도 창가 쪽은 밝고 반대쪽은 어둡기 때문이다. 기준이 하나면
  //    어두운 구석의 종이가 통째로 글자로 잡혀 상자가 사진만큼 커진다
  //    (실제로 그림자가 기운 사진에서 87% 를 잡았다).
  const ink = boundsByLocalInk(lum, w, px0, py0, px1, py1);
  // 글자를 못 찾으면 종이까지는 찾은 셈이니 종이를 준다(사진 전체보다 낫다).
  const [left, top, right, bottom] = ink ?? [px0, py0, px1, py1];

  // 글자가 잘리지 않게 여백을 둔다.
  const paddingX = (right - left) * 0.06 + w * 0.015;
  const paddingY = (bottom - top) * 0.08 + h * 0.015;

  // **여백을 붙이더라도 종이 밖으로는 나가지 않는다.** 글자는 종이 위에만
  // 있으므로 그 바깥은 책상이고, 넣어 봐야 인식에 방해만 된다. 빈 종이처럼
  // 찾을 글자가 없는 사진에서 상자가 사진 전체로 벌어지는 것도 이걸로 막힌다.
  const sx = Math.max(paper[0], left - paddingX);
  const sy = Math.max(paper[1], top - paddingY);
  const ex = Math.min(paper[2] + 1, right + paddingX);
  const ey = Math.min(paper[3] + 1, bottom + paddingY);

  const inverseScale = Math.max(naturalWidth / w, naturalHeight / h);
  const rect: CropRect = {
    x: Math.round(sx * inverseScale),
    y: Math.round(sy * inverseScale),
    width: Math.round((ex - sx) * inverseScale),
    height: Math.round((ey - sy) * inverseScale),
  };

  if (rect.width < 20 || rect.height < 20) return fallback;
  return rect;
}

/** 성능을 위해 줄인 뒤 밝기만 뽑는다. 캔버스를 못 읽으면 null. */
function toLuminanceSample(
  image: HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
): { lum: Float32Array; w: number; h: number } | null {
  const maxDim = 700;
  const scale = Math.min(1, maxDim / Math.max(naturalWidth, naturalHeight));
  const w = Math.max(1, Math.round(naturalWidth * scale));
  const h = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, w, h);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // 캔버스가 오염된 경우(CORS 등)는 읽을 수 없다.
    return null;
  }

  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { lum, w, h };
}

/**
 * 밝은 쪽과 어두운 쪽을 가르는 밝기(Otsu).
 *
 * 두 무리의 분산 합이 가장 작아지는 값을 고른다. 무엇이 종이이고 무엇이
 * 책상인지 우리가 정하지 않아도 되는 것이 요점이다 — 조명이 어두우면 두 값이
 * 함께 내려가므로 고정 임계값처럼 통째로 틀리지 않는다.
 */
function otsuThreshold(lum: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[Math.max(0, Math.min(255, lum[i] | 0))]++;

  const total = lum.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumBack = 0;
  let weightBack = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

/**
 * 조건에 맞는 픽셀이 **줄마다 얼마나 촘촘한지**로 경계를 잡는다.
 *
 * 픽셀 하나만 있어도 경계를 늘리면 잡티·먼지·가장자리 그림자에 통째로
 * 끌려간다(예전이 그랬다). 그래서 **그 줄의 최대 촘촘함에 견주어** 자른다 —
 * 종이든 글자든 대상은 여러 줄에 걸쳐 촘촘하고, 잡티는 그러지 못한다.
 */
function boundsByDensity(
  lum: Float32Array,
  w: number,
  h: number,
  match: (v: number) => boolean,
  peakRatio: number,
): [number, number, number, number] | null {
  return boundsByDensityWithin(lum, w, 0, 0, w - 1, h - 1, match, peakRatio);
}

function boundsByDensityWithin(
  lum: Float32Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  match: (v: number) => boolean,
  peakRatio = 0.06,
): [number, number, number, number] | null {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return null;

  const rows = new Float32Array(h);
  const cols = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const base = (y0 + y) * stride;
    for (let x = 0; x < w; x++) {
      if (match(lum[base + x0 + x])) {
        rows[y]++;
        cols[x]++;
      }
    }
  }

  const rowSpan = spanAbove(rows, peakRatio, w);
  const colSpan = spanAbove(cols, peakRatio, h);
  if (!rowSpan || !colSpan) return null;
  return [x0 + colSpan[0], y0 + rowSpan[0], x0 + colSpan[1], y0 + rowSpan[1]];
}

/**
 * 촘촘함이 기준을 넘는 첫 줄과 마지막 줄.
 * 기준은 **최고값의 일정 비율**이되, 아주 얕은 잡티는 절대값으로도 막는다.
 */
function spanAbove(
  density: Float32Array,
  peakRatio: number,
  full: number,
): [number, number] | null {
  let peak = 0;
  for (let i = 0; i < density.length; i++) {
    if (density[i] > peak) peak = density[i];
  }
  if (peak === 0) return null;
  const cut = Math.max(peak * peakRatio, full * 0.01);

  let first = -1;
  let last = -1;
  for (let i = 0; i < density.length; i++) {
    if (density[i] >= cut) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  return [first, last];
}

/**
 * 종이 안에서 글자의 경계를 찾는다. **밝기 기준을 자리마다 따로 잡는다.**
 *
 * 기준이 사진 하나에 하나뿐이면 조명 기울기를 못 견딘다 — 어두운 쪽 종이가
 * 밝은 쪽 글자보다 어두워지는 순간, 그 구석이 통째로 글자로 잡혀 상자가
 * 사진만큼 커진다. 그래서 영역을 칸으로 나누고 **그 칸의 종이 밝기**에 견준다.
 *
 * 칸의 종이 밝기는 "평균보다 밝은 픽셀들의 평균"으로 잡는다. 그냥 평균을 쓰면
 * 글자가 빽빽한 칸에서 기준이 글자 쪽으로 끌려 내려가고, 최댓값을 쓰면 반사광
 * 한 점에 흔들린다.
 *
 * 칸은 글자 몇 줄이 들어갈 만큼 넉넉해야 한다. 글자 한 줄보다 작으면 칸 전체가
 * 글자로 차서 "종이 밝기"라는 것이 없어진다.
 */
function boundsByLocalInk(
  lum: Float32Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number, number] | null {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return null;

  const block = Math.max(16, Math.round(Math.min(w, h) / 10));
  const cols = Math.max(1, Math.ceil(w / block));
  const rowsN = Math.max(1, Math.ceil(h / block));
  const cut = new Float32Array(cols * rowsN);

  for (let by = 0; by < rowsN; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const sxa = x0 + bx * block;
      const sya = y0 + by * block;
      const sxb = Math.min(x1, sxa + block - 1);
      const syb = Math.min(y1, sya + block - 1);

      let sum = 0;
      let n = 0;
      for (let y = sya; y <= syb; y++) {
        const base = y * stride;
        for (let x = sxa; x <= sxb; x++) {
          sum += lum[base + x];
          n++;
        }
      }
      if (n === 0) continue;
      const mean = sum / n;

      // 평균보다 밝은 쪽만 다시 평균 — 이 칸의 "종이" 밝기.
      let bright = 0;
      let bn = 0;
      for (let y = sya; y <= syb; y++) {
        const base = y * stride;
        for (let x = sxa; x <= sxb; x++) {
          const v = lum[base + x];
          if (v >= mean) {
            bright += v;
            bn++;
          }
        }
      }
      const paperLevel = bn > 0 ? bright / bn : mean;
      // 종이보다 뚜렷하게 어두워야 글자다. 비율과 절대값 중 **큰 쪽**을 쓴다 —
      // 어두운 사진에서는 비율이, 밝은 사진에서는 절대값이 일을 한다.
      cut[by * cols + bx] = paperLevel - Math.max(paperLevel * 0.18, 26);
    }
  }

  const rowDensity = new Float32Array(h);
  const colDensity = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const base = (y0 + y) * stride;
    const by = Math.min(rowsN - 1, Math.floor(y / block));
    for (let x = 0; x < w; x++) {
      const bx = Math.min(cols - 1, Math.floor(x / block));
      if (lum[base + x0 + x] < cut[by * cols + bx]) {
        rowDensity[y]++;
        colDensity[x]++;
      }
    }
  }

  const rowSpan = spanAbove(rowDensity, 0.06, w);
  const colSpan = spanAbove(colDensity, 0.06, h);
  if (!rowSpan || !colSpan) return null;
  return [x0 + colSpan[0], y0 + rowSpan[0], x0 + colSpan[1], y0 + rowSpan[1]];
}
