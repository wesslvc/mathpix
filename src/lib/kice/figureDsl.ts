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
export type ContourSpec = {
  type: "contour";
  /** 가로:세로 비. 기본 2.65. */
  aspect?: number;
  /** 등치선 간격과 범위(예: step 1, min −5, max 3). 0 선은 늘 굵게. */
  levels: { step: number; min: number; max: number };
  blobs: Blob[];
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
export type FigureSpec = ContourSpec | StrataSpec | RowSpec;

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
  const f = (u: number, v: number) =>
    sp.blobs.reduce((acc, b) => {
      const du = (u - b.u - (b.lean ?? 0) * (v - b.v)) / b.su;
      const dv = (v - b.v) / b.sv;
      const e = b.p ?? 2;
      return acc + b.a * Math.exp(-(Math.abs(du) ** e) - Math.abs(dv) ** 2);
    }, 0);
  const levels: number[] = [];
  for (let L = sp.levels.min; L <= sp.levels.max + 1e-9; L += sp.levels.step) levels.push(Math.round(L * 1e6) / 1e6);
  // contourLines 의 두 번째 좌표는 아래→위(v) 로 읽는다 — 격자 행 j 가 v = j/ny.
  const frameClip: Pt[] = [[X(0), Y(1)], [X(1), Y(1)], [X(1), Y(0)], [X(0), Y(0)]];
  const lineOps: FigOp[] = [];
  const zeroPaths: Poly[] = [];
  for (const L of levels) {
    for (const line of contourLines(f, L, 320, 130)) {
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

export function renderFigure(spec: FigureSpec): FigureOps {
  switch (spec.type) {
    case "contour": return contourFigure(spec);
    case "strata": return strataFigure(spec);
    case "row": return rowFigure(spec);
  }
}
