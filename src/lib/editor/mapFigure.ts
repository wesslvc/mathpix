/**
 * **백지도 그림**(지리 문항용). 지도 자료는 geogl3(wesslvc/seji)의 백지도에서 뽑아 `public/maps/*.json` 에 두었다
 * (`scripts/maps/extract-geogl3.py`; 세계는 이제 Natural Earth 를 메르카토르로 투영한 것 — `build-world-mercator.py`),
 * 대한민국은 시도 경계(좌표가 위경도가 아니라 그림 좌표다).
 * 이 파일은 순수 함수뿐이다 — 설정(MapSpec)을 평가원풍 흑백 SVG 문자열로 바꾼다.
 */

export type MapKind = "world" | "korea";
/** 평가원 지도의 육지 회색. */
export const LAND_GRAY = "#e4e4e4";
/** 칠하기 단계: 0 흰색(기본) … 4 검정, 5 빗금. */
export const SHADES = ["#ffffff", "#e3e3e3", "#b5b5b5", "#7a7a7a", "#2b2b2b"] as const;
export const SHADE_LABELS = ["흰색", "연회색", "회색", "진회색", "검정", "빗금"] as const;

export type MapMarker = {
  /** 그림 좌표(세계는 메르카토르 2754×1950, 한국은 509×716). */
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
  /** 세계 지도 좌표의 도법. 없으면 옛 로빈슨 좌표라 읽을 때 메르카토르로 옮긴다. */
  proj?: "mercator";
  /** 나라(시도) 경계선을 그릴지 — 없으면 해안선만(평가원 세계 지도처럼). 기본: 세계는 끔, 대한민국은 켬. */
  borders?: boolean;
  /** 선 없음 — 경계선·해안선을 하나도 긋지 않고 땅 모양(칠)만. borders 보다 앞선다. */
  noLines?: boolean;
  /** 육지를 옅은 회색으로(평가원 지도처럼, 기본 켬). 끄면 흰 육지. */
  landGray?: boolean;
  /** 점 모양: 까만 점(평가원, 기본) / 속이 빈 고리. */
  dotStyle?: "ring" | "solid";
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

export const MAP_SIZE: Record<MapKind, [number, number]> = { world: [2754, 1949.729], korea: [509, 716.105] };

/*
 * **세계 백지도는 메르카토르 도법**이다(2026-11-25 교체, 사용자 지시). 원자료는 Natural Earth 1:50m(퍼블릭 도메인)이고
 * scripts/maps/build-world-mercator.py 가 아래와 **같은 식**으로 투영해 public/maps/world.json 을 만든다(중심 경도 0°, 85°N~60°S).
 */
const MERC_W = 2754;
const mercM = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));
const MERC_TOP = mercM(85);
const MERC_K = MERC_W / (2 * Math.PI);
export const WORLD_H = (MERC_TOP - mercM(-60)) * MERC_K;
export function lonLatToXY(lon: number, lat: number): [number, number] {
  return [((lon + 180) / 360) * MERC_W, (MERC_TOP - mercM(lat)) * MERC_K];
}
export function xyToLonLat(x: number, y: number): [number, number] {
  const m = MERC_TOP - y / MERC_K;
  return [(x / MERC_W) * 360 - 180, ((2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180) / Math.PI];
}
/** 경위도 범위를 덮는 그림 좌표 상자(메르카토르라 네 귀퉁이면 된다). */
export function lonLatBox(lon: [number, number], lat: [number, number]): [number, number, number, number] {
  const [x0, y0] = lonLatToXY(Math.min(...lon), Math.max(...lat));
  const [x1, y1] = lonLatToXY(Math.max(...lon), Math.min(...lat));
  return [x0, y0, x1 - x0, y1 - y0];
}

/*
 * (옛 지도) 세계 백지도(Wikimedia BlankMap 계열)는 등장방형이 아니라 **로빈슨 도법, 중심 경도 10°E** 다.
 * 나라 외곽 상자로 맞춰 봤다(2026-11-25): 세로는 y = 699 − 697.4·Y(위도) 로 1~2px 안, 가로는 x = 1377 + 438.3·X(위도)·(경도−10°)[라디안]
 * 로 평균 3px 안이다. 그래서 경도 −170° 가 왼쪽 끝, 190°(=−170°) 가 오른쪽 끝이다.
 */
const ROB_LAT = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
const ROB_X = [1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
const ROB_Y = [0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1];
const ROB_LON0 = 10.2;
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
function robRel(lon: number, center = 0) {
  let d = lon - ROB_LON0;
  while (d - center > 180) d -= 360;
  while (d - center < -180) d += 360;
  return d;
}
function robLonLatToXY(lon: number, lat: number, center = 0): [number, number] {
  const a = Math.min(90, Math.abs(lat));
  const x = CX + SX * interp(ROB_LAT, ROB_X, a) * ((robRel(lon, center) * Math.PI) / 180);
  const y = CY - Math.sign(lat) * SY * interp(ROB_LAT, ROB_Y, a);
  return [x, y];
}
function robXyToLonLat(x: number, y: number): [number, number] {
  const yy = Math.max(-1, Math.min(1, (CY - y) / SY));
  const lat = Math.sign(yy) * interp(ROB_Y, ROB_LAT, Math.abs(yy));
  const lon = ((x - CX) / (SX * interp(ROB_LAT, ROB_X, Math.abs(lat)))) * (180 / Math.PI) + ROB_LON0;
  return [lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon, lat];
}
export function defaultSpec(kind: MapKind): MapSpec {
  const [w, h] = MAP_SIZE[kind];
  if (kind === "world") {
    // 남극은 거의 안 쓴다 — 위도 85°N~60°S 만 보인다.
    return { kind, proj: "mercator", view: lonLatBox([-180, 180], [-60, 85]), fills: {}, markers: [], grid: 0 };
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
  const style = {
    ...(typeof o.borders === "boolean" ? { borders: o.borders } : {}),
    ...(o.landGray === false ? { landGray: false } : {}),
    ...(o.noLines === true ? { noLines: true } : {}),
    ...(o.dotStyle === "ring" || o.dotStyle === "solid" ? { dotStyle: o.dotStyle as "ring" | "solid" } : {}),
  };
  const spec: MapSpec = { kind: o.kind, view: v, fills, markers, grid, ...(paths.length ? { paths } : {}), ...style };
  if (o.kind === "world" && o.proj !== "mercator") return migrateRobinson(spec);
  return o.kind === "world" ? { ...spec, proj: "mercator" } : spec;
}

/** 옛(로빈슨) 세계 지도 설정 → 메르카토르: 표지·선·보이는 영역을 경위도를 거쳐 옮긴다. */
function migrateRobinson(s: MapSpec): MapSpec {
  const mv = ([x, y]: [number, number]): [number, number] => {
    const [lon, lat] = robXyToLonLat(x, y);
    return lonLatToXY(lon, lat);
  };
  const [vx, vy, vw, vh] = s.view;
  const a = robXyToLonLat(vx, vy);
  const b = robXyToLonLat(vx + vw, vy + vh);
  const full = vw > 2000;
  const view = full ? defaultSpec("world").view : lonLatBox([a[0], b[0]], [Math.max(-60, Math.min(a[1], b[1])), Math.min(85, Math.max(a[1], b[1]))]);
  return {
    ...s,
    proj: "mercator",
    view,
    markers: s.markers.map((m) => {
      const [x, y] = mv([m.x, m.y]);
      return { ...m, x, y };
    }),
    ...(s.paths ? { paths: s.paths.map((p) => ({ ...p, pts: p.pts.map(mv) })) } : {}),
  };
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
  /*
   * 정의(빗금·자르기) id 는 지도마다 달라야 한다 — 한 화면에 지도가 둘이면(세계 + 대한민국) 같은 id 를 서로 집어
   * 둘째 지도가 첫째 지도의 자르기 상자로 잘려 통째로 사라졌다. 보이는 영역으로 이름을 짓는다(같은 영역이면 같은 정의라 무해).
   */
  let hh = 0;
  for (const ch of `${spec.kind}${spec.view.join(",")}`) hh = (hh * 31 + ch.charCodeAt(0)) | 0;
  const uid = `m${(hh >>> 0).toString(36)}`;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vx)} ${r(vy)} ${r(vw)} ${r(vh)}">`);
  out.push(
    `<defs><pattern id="${uid}h" patternUnits="userSpaceOnUse" width="${r(sw * 6)}" height="${r(sw * 6)}" patternTransform="rotate(45)"><rect width="${r(sw * 6)}" height="${r(sw * 6)}" fill="#fff"/><line x1="0" y1="0" x2="0" y2="${r(sw * 6)}" stroke="#000" stroke-width="${r(sw * 1.2)}"/></pattern><clipPath id="${uid}c"><rect x="${r(vx)}" y="${r(vy)}" width="${r(vw)}" height="${r(vh)}"/></clipPath></defs>`,
  );
  out.push(`<rect x="${r(vx)}" y="${r(vy)}" width="${r(vw)}" height="${r(vh)}" fill="#fff"/>`);
  const borders = spec.borders ?? spec.kind === "korea";
  const land = spec.landGray === false ? "#ffffff" : LAND_GRAY;
  const shapes: { fill: string; ds: string[] }[] = [];
  for (const [code, ds] of Object.entries(data.shapes)) {
    const lv = spec.fills[code] ?? 0;
    const shown = ds.filter(vis);
    if (shown.length) shapes.push({ fill: lv === 5 ? `url(#${uid}h)` : lv ? SHADES[Math.min(lv, 4)] : land, ds: shown });
  }
  // 경로를 이어 붙이면 안 된다 — 원본 경로가 소문자 m(상대)으로 시작해 앞 경로 끝에서 이어져 버린다.
  const paths = (ds: string[]) => ds.map((d) => `<path d="${d}"/>`).join("");
  const stroked = (x: { fill: string; ds: string[] }) => `<g fill="${x.fill}" stroke="#000" stroke-width="${r(sw * 2.6)}">${paths(x.ds)}</g>`;
  // 덮는 층은 제 색으로 얇게 테두리를 둘러 이음매(안티에일리어싱 실금)까지 덮는다.
  const cover = (x: { fill: string; ds: string[] }) => `<g fill="${x.fill}" stroke="${x.fill}" stroke-width="${r(sw * 0.9)}">${paths(x.ds)}</g>`;
  out.push(`<g clip-path="url(#${uid}c)" stroke-linejoin="round">`);
  if (spec.noLines) {
    // 선 없음: 제 색으로만 칠한다(이음매는 제 색 테두리로 덮인다).
    out.push(`<g>${shapes.map(cover).join("")}</g>`);
  } else if (borders) {
    /*
     * 나라(시도) 경계만: 나라마다 "굵게 긋고 → 선 없이 덮기"를 차례로 하면 그 나라 안쪽 선(대한민국 자료의 시군구 경계)은 덮이고
     * 이웃과의 경계는 뒤에 그린 쪽이 덮지 못한 절반이 남는다.
     */
    for (const x of shapes) out.push(stroked(x) + cover(x));
  } else {
    // 해안선만: 모두 굵게 그은 위에 모두 덮으면 나라 사이 선은 가려지고 바다 쪽 절반만 남는다.
    out.push(`<g>${shapes.map(stroked).join("")}</g><g>${shapes.map(cover).join("")}</g>`);
    // 칠한 나라는 테두리를 다시 그어 둘레가 보이게(평가원 지도에서 칠한 나라는 윤곽이 있다).
    const filled = shapes.filter((x) => x.fill !== land);
    if (filled.length) out.push(`<g fill="none" stroke="#000" stroke-width="${r(sw * 1.1)}">${filled.map((x) => paths(x.ds)).join("")}</g>`);
  }
  if (spec.kind === "world" && spec.grid > 0) {
    const g: string[] = [];
    // 메르카토르라 경선·위선이 모두 곧은 선이다.
    for (let lon = -180; lon <= 180; lon += spec.grid) {
      const [x] = lonLatToXY(lon, 0);
      if (x >= vx && x <= vx + vw) g.push(`M${r(x)} ${r(vy)}V${r(vy + vh)}`);
    }
    for (let lat = -60; lat <= 80; lat += spec.grid) {
      const [, y] = lonLatToXY(0, lat);
      if (y >= vy && y <= vy + vh) g.push(`M${r(vx)} ${r(y)}H${r(vx + vw)}`);
    }
    if (g.length) out.push(`<path fill="none" stroke="#000" stroke-width="${r(sw * 0.6)}" stroke-dasharray="${r(sw * 4)} ${r(sw * 3)}" d="${g.join("")}"/>`);
  }
  out.push(`</g>`);
  for (const p of spec.paths ?? []) out.push(pathSvg(p, sw, uid));
  for (const m of spec.markers) {
    if (m.dot)
      out.push(
        spec.dotStyle !== "ring"
          ? `<circle cx="${r(m.x)}" cy="${r(m.y)}" r="${r(sw * 3.8)}" fill="#000"/>`
          : `<circle cx="${r(m.x)}" cy="${r(m.y)}" r="${r(sw * 3.6)}" fill="#fff" stroke="#000" stroke-width="${r(sw * 2)}"/>`,
      );
    if (m.label) {
      const tx = m.dot ? m.x + sw * 5 : m.x;
      out.push(
        `<text x="${r(tx)}" y="${r(m.y)}" font-family="'KICE Serif','Nanum Myeongjo','Batang',serif" font-size="${r(font)}" font-weight="700" dominant-baseline="middle" text-anchor="${m.dot ? "start" : "middle"}" stroke="#fff" stroke-width="${r(font / 6)}" paint-order="stroke">${esc(m.label)}</text>`,
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

function pathSvg(p: MapPath, sw: number, uid: string): string {
  const fill = p.closed && p.fill ? (p.fill === 5 ? `url(#${uid}h)` : SHADES[Math.min(p.fill, 4)]) : "none";
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
