/**
 * **도식 DSL** — sol 이 설계한 도식을 평가원 규격으로 그린다(원본을 보고 베끼는 게 아니다).
 * sol 은 SVG 좌표를 직접 짜지 않고 "요소 + 숫자"로 도식을 적고(`FigureSpec`), 이 모듈이 선 굵기·점선·무늬·눈금·라벨·원문자 같은
 * 규격을 고정해서 **그리기 명령 목록**(`FigureOps`)으로 바꾼다. 순수 계산이라 DOM·pdf-lib 을 모르고 웹 워커에서도 돈다.
 *
 * 요소(v1): `contour`(등치선·등속선 단면 — 극값 몇 개로 장을 정하면 marching squares 로 등치선을 뽑는다), `strata`(지질 단면 — 다각형 층 +
 * 무늬 + 관입암 + 단층 + 나무), `row`(여러 도식을 가로로 나열 + 공통 범례). 좌표는 도식 안쪽 단위(가로 1000)이고 y 는 아래가 +다.
 */
import { contourLines, type Poly } from "./contourField";

// ---------- 그리기 명령 ----------
export type Pt = [number, number];
export type FigOp =
  | { t: "poly"; pts: Pt[]; fill?: number; stroke?: number; dash?: [number, number]; close?: boolean }
  | { t: "line"; pts: Pt[]; th: number; dash?: [number, number] }
  | { t: "text"; x: number; y: number; s: string; size: number; italic?: boolean; anchor?: "l" | "c" | "r"; bold?: boolean; vertical?: boolean }
  | { t: "circ"; x: number; y: number; ch: string; size: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; fill?: number; stroke?: number }
  | { t: "ellipse"; x: number; y: number; rx: number; ry: number; fill?: number }
  | { t: "group"; clip: Pt[]; ops: FigOp[] };
export type FigureOps = { w: number; h: number; ops: FigOp[] };

// ---------- 규격 상수(원본 사진에서 잰 값 — 가로 1000 기준) ----------
const TH_THIN = 1.7;
const TH_ZERO = 5.2;
const TH_FRAME = 2.1;
const DASH: [number, number] = [9, 6];
const F_TICK = 29;
const F_TITLE = 33;
const F_LABEL = 30;

// ---------- 스펙 ----------
export type Blob = {
  /** 극값 위치 (0~1, v=0 이 아래). */
  u: number;
  v: number;
  /** 퍼짐(0~1 단위). */
  su: number;
  sv: number;
  /** 크기(부호 = 남풍 + / 북풍 −). */
  a: number;
  /** 기울기: 위로 갈수록 오른쪽(+)/왼쪽(−)으로 얼마나 밀리는지(u 단위/v 단위). 비대칭 극값을 만든다. */
  lean?: number;
  /** 모서리 날카로움 지수(2=가우스, 클수록 평평한 꼭대기·가파른 옆면). */
  p?: number;
};
/**
 * 띠 영역 — 영(0)선으로 갈린 한 구간. 왼쪽·오른쪽 경계를 곡선(아래→위 점들 `[u,v]`)으로 주고 크기 `a`(부호 = 남풍 + / 북풍 −)를 주면, 경계에서
 * 0 이고 구간 가운데로 갈수록 커지는 장이 되어 **경계를 따라 겹겹이 도는 등치선**이 나온다(실제 등속선 단면의 모양).
 */
export type Region = {
  left: Pt[];
  right: Pt[];
  a: number;
  /** 이 높이(v)에서 장이 0 으로 사라진다(기본 1.15). */
  vtop?: number;
  /** 가로 방향 프로필 지수(작을수록 평평한 가운데·가파른 가장자리, 기본 0.8). */
  q?: number;
  /** 세로 감쇠 지수(기본 0.7). */
  r?: number;
  /** 가장 센 곳의 가로 위치(0=왼쪽 경계, 1=오른쪽 경계, 기본 0.5). */
  peak?: number;
};
export type ContourSpec = {
  type: "contour";
  /** 띠 영역(경계 곡선 방식). `blobs` 와 함께 쓸 수 있다. */
  regions?: Region[];
  /** 가로:세로 비. 기본 2.65. */
  aspect?: number;
  /** 등치선 간격과 범위(예: step 1, min −5, max 3). 0 선은 늘 굵게. */
  levels: { step: number; min: number; max: number };
  blobs?: Blob[];
  /** 영(0) 라벨 위치(흰 바탕 숫자). 안 주면 굵은 선에 자동으로 몇 개. */
  zeroLabels?: [number, number][];
  /** 값 라벨(예: 극값 근처 "2"). */
  valueLabels?: { u: number; v: number; text: string }[];
  /** 가로 눈금: [위치 0~1, 글자]. */
  xTicks?: [number, string][];
  xTitle?: string;
  yTitle?: string;
  unitBox?: string;
  /** 음영 구간(0~1)과 위쪽 표지(예: ㉠ 화살표). */
  shades?: { u0: number; u1: number; mark?: { ch: string; style: "arrow" | "bracket" } }[];
  /** 도식 아래 제목(예: "A (북반구 겨울철)"). */
  title?: string;
};
export type PatternKind = "plus" | "v" | "dots" | "brick" | "hlines" | "none";
export type StrataSpec = {
  type: "strata";
  aspect?: number;
  /** 층·암체 다각형(0~1 좌표, y 아래가 +). 그리는 순서대로 덮는다. */
  bodies: { pts: Pt[]; fill?: number; pattern?: PatternKind; outline?: boolean }[];
  /** 선(지층 경계·단층 등). `thick` 은 단층 같은 굵은 선. */
  lines?: { pts: Pt[]; thick?: boolean; dashed?: boolean }[];
  /** 위쪽 지표 기호. */
  trees?: number[];
  /** 라벨(이탤릭이면 변수 f·f′). */
  labels?: { u: number; v: number; text: string; italic?: boolean; halo?: boolean; size?: number }[];
  frame?: boolean;
};
export type RowSpec = {
  type: "row";
  gap?: number;
  /** 가운데 위 범례(선 모양 : 뜻). */
  legend?: { items: { kind: "solid" | "dashed"; text: string }[] };
  panels: ContourSpec[];
};
/**
 * **지질 단면 빌더** — sol 이 다각형 교점을 손으로 계산하지 않도록, 부정합·기울어진 지층·단층(낙차)·관입암을 높은 수준 값으로 받아
 * `StrataSpec` 으로 풀어 준다. 좌표는 0~1(y 아래가 +).
 */
export type SectionSpec = {
  type: "section";
  aspect?: number;
  /** 부정합면 높이(v)와 물결 크기. */
  unconformity: { v: number; wave?: number };
  /** 부정합 위 수평 지층 줄 수(가로줄 무늬). */
  upperLines?: number;
  /** 부정합 아래 지층들(위 → 아래). `h` 는 두께(그림 높이 비율). 기울기 `dip` 은 오른쪽 끝에서 얼마나 내려가는지(v). */
  lower: { dip?: number; layers: { h: number; fill?: number; pattern?: PatternKind }[] };
  /** 단층: 위→아래 두 점. `throw` 는 오른쪽 블록이 내려간 양(v). */
  faults?: { from: Pt; to: Pt; throw?: number }[];
  /** 관입암(암맥): 바닥 폭 [u0,u1] 와 꼭대기 폭 [u0,u1]. 꼭대기는 부정합면에서 멈춘다(`topV` 를 주면 그 높이). */
  intrusions?: { bottom: [number, number]; top: [number, number]; pattern?: PatternKind; fill?: number; topV?: number }[];
  trees?: number[];
  labels?: StrataSpec["labels"];
};
export type FigureSpec = ContourSpec | StrataSpec | RowSpec | SectionSpec;

const W = 1000;

// ---------- 공통 보조 ----------
const shift = (ops: FigOp[], dx: number, dy: number): FigOp[] =>
  ops.map((o): FigOp => {
    switch (o.t) {
      case "poly":
      case "line": return { ...o, pts: o.pts.map(([x, y]) => [x + dx, y + dy] as Pt) };
      case "group": return { ...o, clip: o.clip.map(([x, y]) => [x + dx, y + dy] as Pt), ops: shift(o.ops, dx, dy) };
      default: return { ...o, x: o.x + dx, y: o.y + dy };
    }
  });

/** 폴리라인을 부드럽게(Chaikin 한 번) 만든다. */
const smooth = (p: Poly, n = 1): Poly => {
  let cur = p;
  for (let k = 0; k < n; k++) {
    const out: Poly = [];
    const closed = cur.length > 3 && cur[0][0] === cur[cur.length - 1][0] && cur[0][1] === cur[cur.length - 1][1];
    for (let i = 0; i < cur.length - 1; i++) {
      const [x0, y0] = cur[i];
      const [x1, y1] = cur[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    if (!closed && cur.length) { out.unshift(cur[0]); out.push(cur[cur.length - 1]); }
    else if (out.length) out.push(out[0]);
    cur = out;
  }
  return cur;
};

// ---------- 등치선 ----------
function contourFigure(sp: ContourSpec, K = 1): FigureOps {
  const aspect = sp.aspect ?? 2.65;
  const pw = W;
  const ph = W / aspect;
  const pad = { l: 60 * K, r: 40 * K, t: 70 * K, b: 150 * K }; // 눈금·제목 자리
  const ops: FigOp[] = [];
  const X = (u: number) => pad.l + u * (pw - pad.l - pad.r);
  const pwi = pw - pad.l - pad.r;
  const Y = (v: number) => pad.t + (1 - v) * ph; // v: 0 = 아래
  // 음영
  for (const s of sp.shades ?? []) {
    ops.push({ t: "rect", x: X(s.u0), y: Y(1), w: (s.u1 - s.u0) * pwi, h: ph, fill: 0.8 });
  }
  // 장
  const NX = 320;
  const NY = 130;
  const curveAt = (c: Pt[], v: number): number => {
    // c: 아래→위(v 증가) 점들. v 에서 u 를 선형 보간한다(범위 밖은 끝값).
    if (v <= c[0][1]) return c[0][0];
    for (let i = 1; i < c.length; i++) {
      if (v <= c[i][1]) {
        const [u0, v0] = c[i - 1];
        const [u1, v1] = c[i];
        return v1 === v0 ? u1 : u0 + ((u1 - u0) * (v - v0)) / (v1 - v0);
      }
    }
    return c[c.length - 1][0];
  };
  const grid = new Float32Array((NX + 1) * (NY + 1));
  const blobs = sp.blobs ?? [];
  const regions = sp.regions ?? [];
  const rInfo = regions.map((r) => {
    let hw = 0;
    for (let j = 0; j <= 40; j++) hw = Math.max(hw, (curveAt(r.right, j / 40) - curveAt(r.left, j / 40)) / 2);
    return hw || 0.01;
  });
  for (let j = 0; j <= NY; j++) {
    const v = j / NY;
    for (let i = 0; i <= NX; i++) {
      const u = i / NX;
      let val = 0;
      for (const b of blobs) {
        const du = (u - b.u - (b.lean ?? 0) * (v - b.v)) / b.su;
        const dv = (v - b.v) / b.sv;
        val += b.a * Math.exp(-(Math.abs(du) ** (b.p ?? 2)) - Math.abs(dv) ** 2);
      }
      regions.forEach((r, k) => {
        const L = curveAt(r.left, v);
        const R = curveAt(r.right, v);
        if (u <= L || u >= R) return;
        const width = R - L;
        const t = (u - L) / width; // 0..1
        const pk = r.peak ?? 0.5;
        const shape = t < pk ? t / pk : (1 - t) / (1 - pk);
        const prof = Math.pow(Math.max(0, shape), r.q ?? 0.8) * Math.min(1, width / (2 * rInfo[k]));
        const vt = r.vtop ?? 1.15;
        // 바닥값을 둬서 높은 곳에서도 부호가 유지되게 한다(0 이 되면 가짜 영(0)선이 가로로 생긴다).
        const vert = 0.03 + 0.97 * Math.pow(Math.max(0, 1 - v / vt), r.r ?? 0.7);
        val += r.a * prof * vert;
      });
      grid[j * (NX + 1) + i] = val;
    }
  }
  const f = (u: number, v: number) => grid[Math.round(v * NY) * (NX + 1) + Math.round(u * NX)];
  const levels: number[] = [];
  for (let L = sp.levels.min; L <= sp.levels.max + 1e-9; L += sp.levels.step) levels.push(Math.round(L * 1e6) / 1e6);
  // contourLines 의 두 번째 좌표는 아래→위(v) 로 읽는다 — 격자 행 j 가 v = j/ny.
  const frameClip: Pt[] = [[X(0), Y(1)], [X(1), Y(1)], [X(1), Y(0)], [X(0), Y(0)]];
  const lineOps: FigOp[] = [];
  const zeroPaths: Poly[] = [];
  for (const L of levels) {
    for (const line of contourLines(f, L, NX, NY)) {
      const pts = smooth(line, 1).map(([u, v]) => [X(u), Y(v)] as Pt);
      if (L === 0) {
        lineOps.push({ t: "line", pts, th: (TH_ZERO * K) });
        zeroPaths.push(line);
      } else lineOps.push({ t: "line", pts, th: (TH_THIN * K), ...(L < 0 ? { dash: [DASH[0] * K, DASH[1] * K] as [number, number] } : {}) });
    }
  }
  ops.push({ t: "group", clip: frameClip, ops: lineOps });
  // 영 라벨 — 굵은 선 위에 흰 바탕 숫자(선이 라벨 자리에서 끊긴 것처럼 보인다).
  const zl = sp.zeroLabels ?? autoZeroLabels(zeroPaths, 7);
  const labelOps: FigOp[] = [];
  for (const [u, v] of zl) {
    labelOps.push({ t: "rect", x: X(u) - 15 * K, y: Y(v) - 27 * K, w: 30 * K, h: 46 * K, fill: 1 });
    labelOps.push({ t: "text", x: X(u), y: Y(v) + 12 * K, s: "0", size: (F_LABEL * K), anchor: "c" });
  }
  for (const vl of sp.valueLabels ?? []) {
    labelOps.push({ t: "rect", x: X(vl.u) - 15 * K, y: Y(vl.v) - 27 * K, w: 30 * K, h: 46 * K, fill: 1 });
    labelOps.push({ t: "text", x: X(vl.u), y: Y(vl.v) + 12 * K, s: vl.text, size: (F_LABEL * K), anchor: "c" });
  }
  ops.push({ t: "group", clip: frameClip, ops: labelOps });
  // 틀
  ops.push({ t: "poly", pts: [[X(0), Y(1)], [X(1), Y(1)], [X(1), Y(0)], [X(0), Y(0)]], stroke: (TH_FRAME * K), close: true });
  // 단위 상자
  if (sp.unitBox) {
    const bw = (sp.unitBox.length * 24 + 24) * K;
    ops.push({ t: "rect", x: X(0), y: Y(1), w: bw, h: 56 * K, fill: 1, stroke: 1.8 * K });
    ops.push({ t: "text", x: X(0) + 12 * K, y: Y(1) + 40 * K, s: sp.unitBox, size: 32 * K });
  }
  // 눈금 글자·제목
  for (const [u, s] of sp.xTicks ?? []) ops.push({ t: "text", x: X(u), y: Y(0) + 38 * K, s, size: (F_TICK * K), anchor: "c" });
  ops.push({ t: "text", x: X(0) - 14 * K, y: Y(0) + 8 * K, s: "0", size: (F_TICK * K), anchor: "r" });
  if (sp.xTitle) ops.push({ t: "text", x: X(0.5), y: Y(0) + 76 * K, s: sp.xTitle, size: (F_TICK * K), anchor: "c" });
  if (sp.yTitle) {
    ops.push({ t: "text", x: X(0) - 34 * K, y: Y(0.5) + 18 * K, s: sp.yTitle, size: 28 * K, anchor: "c", vertical: true });
    ops.push({ t: "text", x: X(0) - 34 * K, y: Y(0.78), s: "↑", size: 28 * K, anchor: "c" });
  }
  if (sp.title) ops.push({ t: "text", x: X(0.5), y: Y(0) + 122 * K, s: sp.title, size: (F_TITLE * K), anchor: "c" });
  // 위쪽 표지(㉠ 화살표/괄호)
  for (const s of sp.shades ?? []) {
    if (!s.mark) continue;
    const cx = (X(s.u0) + X(s.u1)) / 2;
    ops.push({ t: "circ", x: cx, y: Y(1) - 44 * K, ch: s.mark.ch, size: 36 * K });
    const y = Y(1) - 14 * K;
    ops.push({ t: "line", pts: [[X(s.u0), y], [X(s.u1), y]], th: 1.8 * K });
    if (s.mark.style === "arrow") {
      ops.push({ t: "poly", pts: [[X(s.u0), y], [X(s.u0) + 12 * K, y - 6 * K], [X(s.u0) + 12 * K, y + 6 * K]], fill: 0, close: true });
      ops.push({ t: "poly", pts: [[X(s.u1), y], [X(s.u1) - 12 * K, y - 6 * K], [X(s.u1) - 12 * K, y + 6 * K]], fill: 0, close: true });
    } else {
      ops.push({ t: "line", pts: [[X(s.u0), y - 10 * K], [X(s.u0), y + 10 * K]], th: 1.8 * K });
      ops.push({ t: "line", pts: [[X(s.u1), y - 10 * K], [X(s.u1), y + 10 * K]], th: 1.8 * K });
    }
  }
  return { w: pw, h: pad.t + ph + pad.b, ops };
}

/** 굵은 0선 위에서 일정 간격으로 라벨 자리를 고른다. */
function autoZeroLabels(paths: Poly[], n: number): [number, number][] {
  const pts: [number, number][] = [];
  const long = [...paths].sort((a, b) => b.length - a.length).slice(0, n);
  for (const p of long) {
    const m = p[Math.floor(p.length * 0.5)];
    if (m[1] > 0.12 && m[1] < 0.9 && m[0] > 0.04 && m[0] < 0.96) pts.push([m[0], m[1]]);
  }
  return pts;
}

// ---------- 지질 단면 ----------
function strataFigure(sp: StrataSpec): FigureOps {
  const aspect = sp.aspect ?? 1.42;
  const w = W;
  const h = W / aspect;
  const pad = { t: 70, b: 120 };
  const P = (p: Pt): Pt => [p[0] * w, pad.t + p[1] * h];
  const ops: FigOp[] = [];
  const bodyOps: FigOp[] = [];
  const frame: Pt[] = [[0, pad.t], [w, pad.t], [w, pad.t + h], [0, pad.t + h]];
  for (const b of sp.bodies) {
    const pts = b.pts.map(P);
    bodyOps.push({ t: "poly", pts, fill: b.fill ?? 1, stroke: b.outline ? 1.6 : undefined, close: true });
    if (b.pattern && b.pattern !== "none") {
      const inner = patternOps(b.pattern, pts);
      bodyOps.push({ t: "group", clip: pts, ops: inner });
    }
  }
  ops.push({ t: "group", clip: frame, ops: bodyOps });
  const lineOps: FigOp[] = [];
  for (const l of sp.lines ?? []) lineOps.push({ t: "line", pts: smooth(l.pts.map(P), 0), th: l.thick ? 6.5 : 1.7, ...(l.dashed ? { dash: DASH } : {}) });
  ops.push({ t: "group", clip: frame, ops: lineOps });
  for (const t of sp.trees ?? []) {
    const x = t * w;
    const y = pad.t - 6;
    ops.push({ t: "line", pts: [[x, y], [x, y - 22]], th: 1.6 });
    ops.push({ t: "ellipse", x, y: y - 34, rx: 11, ry: 19, fill: 0.35 });
  }
  if (sp.frame !== false) ops.push({ t: "poly", pts: frame, stroke: 2.2, close: true });
  for (const lb of sp.labels ?? []) {
    const [x, y] = P([lb.u, lb.v]);
    const size = lb.size ?? 46;
    if (lb.halo) ops.push({ t: "ellipse", x, y: y - size * 0.3, rx: size * 0.55 + 6, ry: size * 0.65, fill: 1 });
    ops.push({ t: "text", x, y, s: lb.text, size, italic: lb.italic, anchor: "c" });
  }
  return { w, h: pad.t + h + pad.b, ops };
}

function bbox(pts: Pt[]) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** 무늬를 격자에 깔아 다각형으로 자른다(group clip 이 그린다). 격자는 도식 좌표에 고정이라 이웃 몸체와 이어진다. */
function patternOps(kind: PatternKind, pts: Pt[]): FigOp[] {
  const b = bbox(pts);
  const ops: FigOp[] = [];
  const rnd = (i: number, j: number) => {
    const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  if (kind === "plus" || kind === "v") {
    const sx = 74;
    const sy = 62;
    for (let j = Math.floor(b.y0 / sy) - 1; j <= Math.ceil(b.y1 / sy) + 1; j++) {
      for (let i = Math.floor(b.x0 / sx) - 1; i <= Math.ceil(b.x1 / sx) + 1; i++) {
        const x = i * sx + (j % 2 ? sx / 2 : 0) + (rnd(i, j) - 0.5) * 14;
        const y = j * sy + (rnd(j, i) - 0.5) * 12;
        if (kind === "plus") {
          ops.push({ t: "line", pts: [[x - 9, y], [x + 9, y]], th: 2 }, { t: "line", pts: [[x, y - 9], [x, y + 9]], th: 2 });
        } else {
          ops.push({ t: "line", pts: [[x - 8, y - 6], [x, y + 6], [x + 8, y - 6]], th: 1.8 });
        }
      }
    }
  } else if (kind === "dots") {
    const s = 21;
    for (let j = Math.floor(b.y0 / s) - 1; j <= Math.ceil(b.y1 / s) + 1; j++) {
      for (let i = Math.floor(b.x0 / s) - 1; i <= Math.ceil(b.x1 / s) + 1; i++) {
        ops.push({ t: "ellipse", x: i * s + rnd(i, j) * s, y: j * s + rnd(j, i + 7) * s, rx: 2.7, ry: 2.7, fill: 0 });
      }
    }
  } else if (kind === "brick") {
    const hgt = 38;
    const wid = 78;
    for (let j = Math.floor(b.y0 / hgt); j <= Math.ceil(b.y1 / hgt); j++) {
      ops.push({ t: "line", pts: [[b.x0 - 5, j * hgt], [b.x1 + 5, j * hgt]], th: 1.6 });
      for (let i = Math.floor(b.x0 / wid) - 1; i <= Math.ceil(b.x1 / wid) + 1; i++) {
        const x = i * wid + (j % 2 ? wid / 2 : 0);
        ops.push({ t: "line", pts: [[x, j * hgt], [x, (j + 1) * hgt]], th: 1.6 });
      }
    }
  } else if (kind === "hlines") {
    for (let y = Math.ceil(b.y0 / 22) * 22; y < b.y1; y += 22) ops.push({ t: "line", pts: [[b.x0 - 5, y], [b.x1 + 5, y]], th: 1.4 });
  }
  return ops;
}

// ---------- 가로 나열 ----------
function rowFigure(sp: RowSpec): FigureOps {
  const gap = sp.gap ?? 40;
  const boost = 1 + 0.75 * (sp.panels.length - 1);
  const parts = sp.panels.map((p) => contourFigure(p, boost));
  const pw = parts[0].w;
  const total = parts.length * pw + (parts.length - 1) * gap;
  const ops: FigOp[] = [];
  let top = 0;
  if (sp.legend) {
    const lw = 380 * boost;
    const lx = (total - lw) / 2;
    top = 56 * boost;
    ops.push({ t: "rect", x: lx, y: 0, w: lw, h: 52 * boost, fill: 1, stroke: 1.8 * boost });
    let x = lx + 24 * boost;
    for (const it of sp.legend.items) {
      ops.push({ t: "line", pts: [[x, 26 * boost], [x + 64 * boost, 26 * boost]], th: (it.kind === "solid" ? 2.4 : 1.8) * boost, ...(it.kind === "dashed" ? { dash: [7 * boost, 5 * boost] as [number, number] } : {}) });
      ops.push({ t: "text", x: x + 78 * boost, y: 38 * boost, s: `: ${it.text}`, size: 30 * boost });
      x += 178 * boost;
    }
  }
  parts.forEach((p, i) => ops.push(...shift(p.ops, i * (pw + gap), top)));
  return { w: total, h: top + Math.max(...parts.map((p) => p.h)), ops };
}

/** 다각형을 직선의 한쪽 반평면으로 자른다(Sutherland–Hodgman). `side` = 직선 (a→b) 의 왼쪽(+1)/오른쪽(−1). */
function clipHalf(poly: Pt[], a: Pt, b: Pt, side: 1 | -1): Pt[] {
  const sd = (p: Pt) => side * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = sd(p);
    const dq = sd(q);
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

function sectionToStrata(sp: SectionSpec): StrataSpec {
  const N = 60;
  const unc = (u: number) => sp.unconformity.v + (sp.unconformity.wave ?? 0.012) * Math.sin(u * 14);
  const dip = sp.lower.dip ?? 0;
  // 경계 k 의 기준 높이(왼쪽 끝에서): 부정합면 + 누적 두께(부정합보다 위로 올라간 부분은 잘려 나간다).
  const bases: number[] = [];
  let acc = sp.unconformity.v;
  for (const l of sp.lower.layers) { bases.push(acc); acc += l.h; }
  bases.push(1.6); // 맨 아래는 바닥 아래로
  const bodies: StrataSpec["bodies"] = [];
  const lines: NonNullable<StrataSpec["lines"]> = [];
  const upperTop: Pt[] = Array.from({ length: N + 1 }, (_, i) => [i / N, 0] as Pt);
  bodies.push({ pts: [...upperTop, ...Array.from({ length: N + 1 }, (_, i) => [1 - i / N, unc(1 - i / N)] as Pt)], fill: 1 });
  // 부정합면 위 수평 지층: 곧은 가로줄(마지막 줄은 부정합면을 따라 굽는다).
  const n = sp.upperLines ?? 0;
  for (let k = 1; k <= n; k++) lines.push({ pts: [[0, (sp.unconformity.v * k) / (n + 1)], [1, (sp.unconformity.v * k) / (n + 1)]] });
  const faults = sp.faults ?? [];
  const f0 = faults[0];
  const sides: ("L" | "R" | "ALL")[] = f0 ? ["L", "R"] : ["ALL"];
  for (const side of sides) {
    const off = side === "R" ? f0?.throw ?? 0 : 0;
    const bv = (k: number, u: number) => Math.min(1, bases[k] + dip * u + off);
    sp.lower.layers.forEach((layer, k) => {
      // 맨 위 지층은 단층으로 내려앉은 쪽에서도 부정합면까지 올라온다(그 위 지층은 침식돼 없다).
      const top = Array.from({ length: N + 1 }, (_, i) => [i / N, k === 0 ? unc(i / N) : Math.max(unc(i / N), bv(k, i / N))] as Pt);
      const bot = Array.from({ length: N + 1 }, (_, i) => [1 - i / N, Math.max(unc(1 - i / N), bv(k + 1, 1 - i / N))] as Pt);
      let poly = [...top, ...bot];
      if (f0) poly = clipHalf(poly, f0.from, f0.to, side === "L" ? 1 : -1);
      if (poly.length < 3) return;
      bodies.push({ pts: poly, fill: layer.fill ?? 1, pattern: layer.pattern });
      // 경계선(아래 경계)
      const bl: Pt[] = Array.from({ length: N + 1 }, (_, i) => [i / N, bv(k + 1, i / N)] as Pt).filter((p) => p[1] > unc(p[0]) + 0.003 && p[1] < 1);
      let seg: Pt[] = [];
      const flush = () => { if (seg.length > 1) lines.push({ pts: seg }); seg = []; };
      for (const p of bl) {
        const sideOk = !f0 || (side === "L" ? sdist(p, f0) <= 0 : sdist(p, f0) >= 0);
        if (sideOk) seg.push(p); else flush();
      }
      flush();
    });
  }
  lines.push({ pts: Array.from({ length: N + 1 }, (_, i) => [i / N, unc(i / N)] as Pt) });
  for (const f of faults) lines.push({ pts: [f.from, f.to], thick: true });
  for (const it of sp.intrusions ?? []) {
    const topY = (u: number) => it.topV ?? unc(u);
    bodies.push({
      pts: [[it.bottom[0], 1], [it.bottom[1], 1], [it.top[1], topY(it.top[1])], [it.top[0], topY(it.top[0])]],
      fill: it.fill ?? 1,
      pattern: it.pattern ?? "plus",
      outline: true,
    });
  }
  return { type: "strata", aspect: sp.aspect, bodies, lines, trees: sp.trees, labels: sp.labels };
}
/** 점 p 가 직선 (a→b) 의 왼쪽이면 음수(화면 좌표계에서 아래로 향하는 단층 기준: 왼쪽 블록 = 음수 쪽이 아니라 부호 규약을 맞춘다). */
function sdist(p: Pt, f: { from: Pt; to: Pt }): number {
  return -((f.to[0] - f.from[0]) * (p[1] - f.from[1]) - (f.to[1] - f.from[1]) * (p[0] - f.from[0]));
}

export function renderFigure(spec: FigureSpec): FigureOps {
  switch (spec.type) {
    case "section": return strataFigure(sectionToStrata(spec));
    case "contour": return contourFigure(spec);
    case "strata": return strataFigure(spec);
    case "row": return rowFigure(spec);
  }
}
