/**
 * **백지도 그림**(지리 문항용). 지도 자료는 geogl3(wesslvc/seji)의 백지도에서 뽑아 `public/maps/*.json` 에 두었다
 * (`scripts/maps/extract-geogl3.py`). 세계는 등장방형(x=(경도+180)/360·2754, y=(90-위도)/180·1398),
 * 대한민국은 시도 경계(좌표가 위경도가 아니라 그림 좌표다).
 * 이 파일은 순수 함수뿐이다 — 설정(MapSpec)을 평가원풍 흑백 SVG 문자열로 바꾼다.
 */

export type MapKind = "world" | "korea";
/** 칠하기 단계: 0 흰색(기본) … 4 검정, 5 빗금. */
export const SHADES = ["#ffffff", "#e3e3e3", "#b5b5b5", "#7a7a7a", "#2b2b2b"] as const;
export const SHADE_LABELS = ["흰색", "연회색", "회색", "진회색", "검정", "빗금"] as const;

export type MapMarker = {
  /** 그림 좌표(세계는 2754×1398, 한국은 509×716). */
  x: number;
  y: number;
  label: string;
  /** 점을 찍을지(아니면 글자만). */
  dot: boolean;
};

export type MapSpec = {
  kind: MapKind;
  /** 잘라 보일 영역(그림 좌표). */
  view: [number, number, number, number];
  /** 나라·시도 → 칠하기 단계(1~5). */
  fills: Record<string, number>;
  markers: MapMarker[];
  /** 경위선(세계만, 도 단위 간격, 0 이면 없음). */
  grid: number;
  /** 손으로 그은 선(이동 경로·하천)·영역(문화권 범위). */
  paths?: MapPath[];
};

export type MapPath = {
  pts: [number, number][];
  /** 닫힌 영역이면 true. */
  closed: boolean;
  /** 점선. */
  dash: boolean;
  /** 끝에 화살촉(열린 선만). */
  arrow: boolean;
  /** 영역 칠하기(0 = 없음, 1~5 = SHADES/빗금). */
  fill: number;
  /** 부드럽게(곡선). */
  smooth: boolean;
};

export type MapData = { viewBox: number[]; shapes: Record<string, string[]> };

export const MAP_SIZE: Record<MapKind, [number, number]> = { world: [2754, 1398], korea: [509, 716.105] };

/*
 * 세계 백지도(Wikimedia BlankMap 계열)는 등장방형이 아니라 **로빈슨 도법, 중심 경도 10°E** 다.
 * 나라 외곽 상자로 맞춰 봤다(2026-11-25): 세로는 y = 699 − 697.4·Y(위도) 로 1~2px 안, 가로는 x = 1377 + 438.3·X(위도)·(경도−10°)[라디안]
 * 로 평균 3px 안이다. 그래서 경도 −170° 가 왼쪽 끝, 190°(=−170°) 가 오른쪽 끝이다.
 */
const ROB_LAT = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
const ROB_X = [1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
const ROB_Y = [0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1];
export const WORLD_LON0 = 10.2;
const CX = 1377;
const SX = 2754 / (2 * Math.PI);
const CY = 699;
const SY = 697.4;
function interp(xs: number[], ys: number[], v: number) {
  if (v <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (v <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (v - xs[i - 1])) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
}
/** 경도를 중심 경도 기준 −180~180 으로 접는다(`center` 를 주면 그 근처로 이어 붙인다). */
export function relLon(lon: number, center = 0) {
  let d = lon - WORLD_LON0;
  while (d - center > 180) d -= 360;
  while (d - center < -180) d += 360;
  return d;
}
export function lonLatToXY(lon: number, lat: number, center = 0): [number, number] {
  const a = Math.min(90, Math.abs(lat));
  const x = CX + SX * interp(ROB_LAT, ROB_X, a) * ((relLon(lon, center) * Math.PI) / 180);
  const y = CY - Math.sign(lat) * SY * interp(ROB_LAT, ROB_Y, a);
  return [x, y];
}
export function xyToLonLat(x: number, y: number): [number, number] {
  const yy = Math.max(-1, Math.min(1, (CY - y) / SY));
  const lat = Math.sign(yy) * interp(ROB_Y, ROB_LAT, Math.abs(yy));
  const lon = ((x - CX) / (SX * interp(ROB_LAT, ROB_X, Math.abs(lat)))) * (180 / Math.PI) + WORLD_LON0;
  return [lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon, lat];
}
/** 경위도 범위를 덮는 그림 좌표 상자(로빈슨이라 네 귀퉁이만으로는 모자라 가장자리를 훑는다). */
export function lonLatBox(lon: [number, number], lat: [number, number]): [number, number, number, number] {
  const [lo0, lo1] = [Math.min(...lon), Math.max(...lon)];
  const [la0, la1] = [Math.min(...lat), Math.max(...lat)];
  if (lo1 - lo0 >= 340) {
    const [, y0] = lonLatToXY(0, la1);
    const [, y1] = lonLatToXY(0, la0);
    return [0, y0, 2754, y1 - y0];
  }
  const center = relLon((lo0 + lo1) / 2);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i <= 24; i++) {
    for (const [lo, la] of [
      [lo0 + ((lo1 - lo0) * i) / 24, la0],
      [lo0 + ((lo1 - lo0) * i) / 24, la1],
      [lo0, la0 + ((la1 - la0) * i) / 24],
      [lo1, la0 + ((la1 - la0) * i) / 24],
    ]) {
      const [x, y] = lonLatToXY(lo, la, center);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

export function defaultSpec(kind: MapKind): MapSpec {
  const [w, h] = MAP_SIZE[kind];
  if (kind === "world") {
    // 남극은 거의 안 쓴다 — 위도 85°N~60°S 만 보인다.
    return { kind, view: lonLatBox([-180, 180], [-60, 85]), fills: {}, markers: [], grid: 0 };
  }
  return { kind, view: [0, 0, w, h], fills: {}, markers: [], grid: 0 };
}

export function readMapSpec(raw: unknown): MapSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "world" && o.kind !== "korea") return null;
  const v = Array.isArray(o.view) && o.view.length === 4 && o.view.every((n) => Number.isFinite(Number(n))) ? (o.view.map(Number) as MapSpec["view"]) : defaultSpec(o.kind).view;
  const fills: Record<string, number> = {};
  if (o.fills && typeof o.fills === "object")
    for (const [k, n] of Object.entries(o.fills as Record<string, unknown>)) {
      const i = Math.round(Number(n));
      if (k.length <= 40 && i >= 1 && i <= 5) fills[k] = i;
    }
  const markers: MapMarker[] = Array.isArray(o.markers)
    ? o.markers.slice(0, 40).flatMap((m) => {
        const r = (m ?? {}) as Record<string, unknown>;
        const x = Number(r.x), y = Number(r.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
        return [{ x, y, label: String(r.label ?? "").slice(0, 20), dot: r.dot !== false }];
      })
    : [];
  const grid = [0, 10, 15, 20, 30].includes(Number(o.grid)) ? Number(o.grid) : 0;
  const paths: MapPath[] = Array.isArray(o.paths)
    ? o.paths.slice(0, 30).flatMap((p) => {
        const q = (p ?? {}) as Record<string, unknown>;
        const pts = Array.isArray(q.pts)
          ? q.pts.slice(0, 200).flatMap((pt) => (Array.isArray(pt) && pt.length === 2 && pt.every((n) => Number.isFinite(Number(n))) ? [[Number(pt[0]), Number(pt[1])] as [number, number]] : []))
          : [];
        if (pts.length < 2) return [];
        const f = Math.round(Number(q.fill));
        return [{ pts, closed: q.closed === true, dash: q.dash === true, arrow: q.arrow === true, fill: f >= 1 && f <= 5 ? f : 0, smooth: q.smooth === true }];
      })
    : [];
  return { kind: o.kind, view: v, fills, markers, grid, ...(paths.length ? { paths } : {}) };
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 칠하지 않은 경로 중 보이는 영역과 안 겹치는 것을 빼려면 bbox 표(경로 문자열 → [x,y,w,h])를 준다. */
export function buildMapSvg(spec: MapSpec, data: MapData, bboxes?: Map<string, [number, number, number, number]>): string {
  const [vx, vy, vw, vh] = spec.view;
  const sw = Math.max(vw, vh) / 700; // 선 굵기: 보이는 크기에 맞춘다
  const font = Math.max(vw, vh) / 26;
  const vis = (d: string) => {
    const b = bboxes?.get(d);
    if (!b) return true;
    return b[0] < vx + vw && b[0] + b[2] > vx && b[1] < vy + vh && b[1] + b[3] > vy;
  };
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vx)} ${r(vy)} ${r(vw)} ${r(vh)}">`);
  out.push(
    `<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="${r(sw * 6)}" height="${r(sw * 6)}" patternTransform="rotate(45)"><rect width="${r(sw * 6)}" height="${r(sw * 6)}" fill="#fff"/><line x1="0" y1="0" x2="0" y2="${r(sw * 6)}" stroke="#000" stroke-width="${r(sw * 1.2)}"/></pattern><clipPath id="clip"><rect x="${r(vx)}" y="${r(vy)}" width="${r(vw)}" height="${r(vh)}"/></clipPath></defs>`,
  );
  out.push(`<rect x="${r(vx)}" y="${r(vy)}" width="${r(vw)}" height="${r(vh)}" fill="#fff"/>`);
  out.push(`<g clip-path="url(#clip)" stroke="#000" stroke-width="${r(sw)}" stroke-linejoin="round">`);
  for (const [code, ds] of Object.entries(data.shapes)) {
    const lv = spec.fills[code] ?? 0;
    const fill = lv === 5 ? "url(#hatch)" : SHADES[Math.min(lv, 4)];
    const shown = ds.filter(vis);
    if (!shown.length) continue;
    // 경로를 이어 붙이면 안 된다 — 원본 경로가 소문자 m(상대)으로 시작해 앞 경로 끝에서 이어져 버린다.
    out.push(shown.length === 1 ? `<path fill="${fill}" d="${shown[0]}"/>` : `<g fill="${fill}">${shown.map((d) => `<path d="${d}"/>`).join("")}</g>`);
  }
  if (spec.kind === "world" && spec.grid > 0) {
    const g: string[] = [];
    // 로빈슨이라 경선은 곡선이다 — 위도를 2°씩 훑어 꺾은선으로 긋는다.
    for (let lon = -180; lon < 180; lon += spec.grid) {
      const pts: string[] = [];
      for (let lat = -90; lat <= 90; lat += 2) {
        const [x, y] = lonLatToXY(lon, lat);
        pts.push(`${r(x)} ${r(y)}`);
      }
      g.push(`M${pts.join("L")}`);
    }
    for (let lat = -90 + spec.grid; lat < 90; lat += spec.grid) {
      const [, y] = lonLatToXY(0, lat);
      if (y >= vy && y <= vy + vh) {
        const [xl] = lonLatToXY(WORLD_LON0 - 180, lat, -180);
        const [xr] = lonLatToXY(WORLD_LON0 + 180, lat, 180);
        g.push(`M${r(xl)} ${r(y)}H${r(xr)}`);
      }
    }
    if (g.length) out.push(`<path fill="none" stroke="#000" stroke-width="${r(sw * 0.6)}" stroke-dasharray="${r(sw * 4)} ${r(sw * 3)}" d="${g.join("")}"/>`);
  }
  out.push(`</g>`);
  for (const p of spec.paths ?? []) out.push(pathSvg(p, sw));
  for (const m of spec.markers) {
    if (m.dot) out.push(`<circle cx="${r(m.x)}" cy="${r(m.y)}" r="${r(sw * 3.2)}" fill="#000"/>`);
    if (m.label) {
      const tx = m.dot ? m.x + sw * 5 : m.x;
      out.push(
        `<text x="${r(tx)}" y="${r(m.y)}" font-family="'Nanum Myeongjo','Batang',serif" font-size="${r(font)}" font-weight="700" dominant-baseline="middle" text-anchor="${m.dot ? "start" : "middle"}" stroke="#fff" stroke-width="${r(font / 6)}" paint-order="stroke">${esc(m.label)}</text>`,
      );
    }
  }
  out.push(`<rect x="${r(vx)}" y="${r(vy)}" width="${r(vw)}" height="${r(vh)}" fill="none" stroke="#000" stroke-width="${r(sw * 1.5)}"/>`);
  out.push(`</svg>`);
  return out.join("");
}

/** 점들 → SVG 경로 글(부드럽게면 캣멀롬 곡선). */
export function pathD(p: MapPath): string {
  const pts = p.pts;
  if (!p.smooth || pts.length < 3) return `M${pts.map(([x, y]) => `${r(x)} ${r(y)}`).join("L")}${p.closed ? "Z" : ""}`;
  const n = pts.length;
  const at = (i: number) => (p.closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${r(pts[0][0])} ${r(pts[0][1])}`;
  const last = p.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`;
  }
  return d + (p.closed ? "Z" : "");
}

function pathSvg(p: MapPath, sw: number): string {
  const fill = p.closed && p.fill ? (p.fill === 5 ? "url(#hatch)" : SHADES[Math.min(p.fill, 4)]) : "none";
  const dash = p.dash ? ` stroke-dasharray="${r(sw * 5)} ${r(sw * 3)}"` : "";
  let out = `<path d="${pathD(p)}" fill="${fill}"${p.closed && p.fill ? ' fill-opacity="0.85"' : ""} stroke="#000" stroke-width="${r(sw * 1.6)}" stroke-linejoin="round" stroke-linecap="round"${dash}/>`;
  if (p.arrow && !p.closed && p.pts.length >= 2) {
    const [x1, y1] = p.pts[p.pts.length - 2];
    const [x2, y2] = p.pts[p.pts.length - 1];
    const a = Math.atan2(y2 - y1, x2 - x1);
    const L = sw * 9;
    const pt = (t: number) => `${r(x2 - L * Math.cos(a + t))} ${r(y2 - L * Math.sin(a + t))}`;
    out += `<path d="M${r(x2)} ${r(y2)}L${pt(0.45)}L${pt(-0.45)}Z" fill="#000"/>`;
  }
  return out;
}

function r(n: number) {
  return Math.round(n * 10) / 10;
}

/*
 * 대한민국 백지도 좌표(509×716 그림)는 위경도가 아니다. 시도 외곽 상자(서울·대전·광주·부산·울산·세종)로 1차식을 맞췄다
 * (2026-11-25, 오차 가로 4px·세로 12px 안). 제주는 그림 오른쪽 아래로 옮겨 그린 인셋이라 따로 맞췄다. 울릉도·독도는 그림에 없다.
 */
export function koreaLonLatToXY(lon: number, lat: number): [number, number] {
  if (lat < 33.7 && lon < 127.2) {
    // 제주 인셋(한라산 33.36N 126.53E ≈ 그림 433,672)
    return [380.7 + (lon - 126.15) * 128.26, 710.6 - (lat - 33.11) * 154.1];
  }
  return [-16097.69 + 128.2598 * lon - 0.95936 * lat, 6134.696 - 1.40263 * lon - 154.089 * lat];
}
/** 지도 종류에 맞춰 위경도 → 그림 좌표. */
export function mapLonLatToXY(kind: MapKind, lon: number, lat: number): [number, number] {
  return kind === "korea" ? koreaLonLatToXY(lon, lat) : lonLatToXY(lon, lat);
}
