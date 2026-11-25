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
};

export type MapData = { viewBox: number[]; shapes: Record<string, string[]> };

export const MAP_SIZE: Record<MapKind, [number, number]> = { world: [2754, 1398], korea: [509, 716.105] };

export function lonLatToXY(lon: number, lat: number): [number, number] {
  return [((lon + 180) / 360) * 2754, ((90 - lat) / 180) * 1398];
}
export function xyToLonLat(x: number, y: number): [number, number] {
  return [(x / 2754) * 360 - 180, 90 - (y / 1398) * 180];
}

export function defaultSpec(kind: MapKind): MapSpec {
  const [w, h] = MAP_SIZE[kind];
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
        return [{ x, y, label: String(r.label ?? "").slice(0, 8), dot: r.dot !== false }];
      })
    : [];
  const grid = [0, 10, 15, 20, 30].includes(Number(o.grid)) ? Number(o.grid) : 0;
  return { kind: o.kind, view: v, fills, markers, grid };
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
    out.push(`<path fill="${fill}" d="${shown.join(" ")}"/>`);
  }
  if (spec.kind === "world" && spec.grid > 0) {
    const g: string[] = [];
    for (let lon = -180; lon <= 180; lon += spec.grid) {
      const [x] = lonLatToXY(lon, 0);
      if (x >= vx && x <= vx + vw) g.push(`M${r(x)} ${r(vy)}V${r(vy + vh)}`);
    }
    for (let lat = -90; lat <= 90; lat += spec.grid) {
      const [, y] = lonLatToXY(0, lat);
      if (y >= vy && y <= vy + vh) g.push(`M${r(vx)} ${r(y)}H${r(vx + vw)}`);
    }
    if (g.length) out.push(`<path fill="none" stroke="#000" stroke-width="${r(sw * 0.6)}" stroke-dasharray="${r(sw * 4)} ${r(sw * 3)}" d="${g.join("")}"/>`);
  }
  out.push(`</g>`);
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

function r(n: number) {
  return Math.round(n * 10) / 10;
}
