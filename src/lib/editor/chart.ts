/**
 * **자료 그래프**(평가원 탐구 문제지에 나오는 꼴) — 데이터로 흑백 SVG 를 그린다. 순수 모듈(화면·서버·AI 가 같이 쓴다).
 * AI 가 좌표를 지어내지 않게, 그래프는 언제나 **값 → 계산**으로 그린다.
 *
 * 종류(2028 예시문항 통합사회에 나온 것 전부):
 *   bar      막대(묶음·음수 가능) + 선택적 점 계열(오른쪽 축) — 기후 그래프·국가별 비교
 *   stacked  쌓인 막대(세로)
 *   hbar100  가로 100% 누적 막대(연도별 구성비)
 *   line     꺾은선
 *   area     누적 영역(도시·촌락 인구 변화)
 *   dotrange 두 시점 점 + 잇는 선(가로, 2014년 △ · 2023년 ■)
 *   radar    방사형(육각형) 그래프 — 여러 개를 한 줄로
 *   bubble   거품 그래프(x, y, 크기, 칠하기)
 *   venn     벤 다이어그램(두 원/세 원 + 영역 글자)
 */

export type ChartType = "bar" | "stacked" | "hbar100" | "line" | "area" | "dotrange" | "radar" | "bubble" | "venn";

/** 흑백 인쇄용 칠하기 — 색 대신 명암·무늬로 구분한다. */
export const FILLS = ["white", "light", "gray", "dark", "black", "hatch", "cross", "dots"] as const;
export type Fill = (typeof FILLS)[number];
export const FILL_LABELS: Record<Fill, string> = {
  white: "흰색",
  light: "연회색",
  gray: "회색",
  dark: "진회색",
  black: "검정",
  hatch: "빗금",
  cross: "격자",
  dots: "점무늬",
};
export const MARKERS = ["dot", "circle", "triangle", "square", "squareFill", "diamond"] as const;
export type Marker = (typeof MARKERS)[number];

export type ChartSeries = { name: string; values: (number | null)[]; fill?: Fill; marker?: Marker; axis?: "left" | "right"; as?: "bar" | "dot" | "line" };

export type ChartSpec = {
  type: ChartType;
  title?: string;
  /** 축 이름(왼쪽 위 단위 표시 포함, 예: "(℃)"). */
  yLabel?: string;
  y2Label?: string;
  xLabel?: string;
  categories: string[];
  /** 범주 아래 두 번째 줄(예: "(가)"). */
  groups?: string[];
  series: ChartSeries[];
  yMin?: number;
  yMax?: number;
  yStep?: number;
  y2Min?: number;
  y2Max?: number;
  y2Step?: number;
  xMin?: number;
  xMax?: number;
  xStep?: number;
  /** 범례 자리(없으면 그래프 아래). */
  legend?: "bottom" | "right" | "none";
  /** 그림 아래 작은 글(출처 등). */
  note?: string;
  /** venn: 원 이름과 영역 글자. bubble: 크기 범례(값:이름). */
  extra?: Record<string, string>;
  width?: number;
  height?: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r = (n: number) => Math.round(n * 10) / 10;
const FONT = "'KICE Gothic','Nanum Gothic','Noto Sans KR',sans-serif";

function defs(): string {
  return `<defs>
<pattern id="f-hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" fill="#fff"/><line x1="0" y1="0" x2="0" y2="5" stroke="#000" stroke-width="1.1"/></pattern>
<pattern id="f-cross" patternUnits="userSpaceOnUse" width="5" height="5"><rect width="5" height="5" fill="#fff"/><path d="M0 0H5M0 0V5" stroke="#000" stroke-width="0.8"/></pattern>
<pattern id="f-dots" patternUnits="userSpaceOnUse" width="4" height="4"><rect width="4" height="4" fill="#fff"/><circle cx="2" cy="2" r="0.8" fill="#000"/></pattern>
</defs>`;
}
export function fillPaint(f: Fill | undefined): string {
  switch (f ?? "gray") {
    case "white":
      return "#fff";
    case "light":
      return "#dcdcdc";
    case "gray":
      return "#a6a6a6";
    case "dark":
      return "#5a5a5a";
    case "black":
      return "#111";
    case "hatch":
      return "url(#f-hatch)";
    case "cross":
      return "url(#f-cross)";
    case "dots":
      return "url(#f-dots)";
  }
}
const DEFAULT_FILLS: Fill[] = ["gray", "white", "dark", "hatch", "light", "black", "dots", "cross"];

function marker(m: Marker | undefined, x: number, y: number, s = 4): string {
  switch (m ?? "dot") {
    case "circle":
      return `<circle cx="${r(x)}" cy="${r(y)}" r="${s}" fill="#fff" stroke="#000" stroke-width="1.2"/>`;
    case "triangle":
      return `<path d="M${r(x)} ${r(y - s)}L${r(x + s)} ${r(y + s * 0.8)}L${r(x - s)} ${r(y + s * 0.8)}Z" fill="#fff" stroke="#000" stroke-width="1.2"/>`;
    case "square":
      return `<rect x="${r(x - s)}" y="${r(y - s)}" width="${2 * s}" height="${2 * s}" fill="#fff" stroke="#000" stroke-width="1.2"/>`;
    case "squareFill":
      return `<rect x="${r(x - s)}" y="${r(y - s)}" width="${2 * s}" height="${2 * s}" fill="#111"/>`;
    case "diamond":
      return `<path d="M${r(x)} ${r(y - s)}L${r(x + s)} ${r(y)}L${r(x)} ${r(y + s)}L${r(x - s)} ${r(y)}Z" fill="#111"/>`;
    default:
      return `<circle cx="${r(x)}" cy="${r(y)}" r="${s * 0.85}" fill="#111"/>`;
  }
}
const text = (x: number, y: number, s: string, o: { size?: number; anchor?: string; weight?: number; base?: string } = {}) =>
  `<text x="${r(x)}" y="${r(y)}" font-family="${FONT}" font-size="${o.size ?? 11}" text-anchor="${o.anchor ?? "middle"}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.base ? ` dominant-baseline="${o.base}"` : ""} fill="#111">${esc(s)}</text>`;

function niceStep(span: number, count = 5): number {
  const raw = span / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}
function axisRange(vals: number[], min?: number, max?: number, step?: number, zero = true) {
  const finite = vals.filter((v) => Number.isFinite(v));
  let lo = min ?? Math.min(zero ? 0 : Infinity, ...finite);
  let hi = max ?? Math.max(zero ? 0 : -Infinity, ...finite);
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi === lo) hi = lo + 1;
  const st = step ?? niceStep(hi - lo);
  if (min == null) lo = Math.floor(lo / st) * st;
  if (max == null) hi = Math.ceil(hi / st) * st;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + st / 1e6; v += st) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100));

function legendSvg(items: { name: string; fill?: Fill; marker?: Marker; line?: boolean }[], x: number, y: number, maxW: number): { svg: string; h: number } {
  const out: string[] = [];
  let cx = x;
  let cy = y;
  const rowH = 16;
  out.push(`<rect x="${r(x - 4)}" y="${r(y - 11)}" width="0" height="0"/>`);
  for (const it of items) {
    const w = 22 + it.name.length * 11;
    if (cx + w > x + maxW && cx > x) {
      cx = x;
      cy += rowH;
    }
    if (it.marker) out.push(marker(it.marker, cx + 5, cy - 4, 3.5));
    else if (it.line) out.push(`<line x1="${cx}" y1="${cy - 4}" x2="${cx + 12}" y2="${cy - 4}" stroke="#000" stroke-width="1.4"/>`);
    else out.push(`<rect x="${cx}" y="${cy - 9}" width="11" height="9" fill="${fillPaint(it.fill)}" stroke="#000" stroke-width="0.8"/>`);
    out.push(text(cx + 15, cy, it.name, { size: 10.5, anchor: "start" }));
    cx += w;
  }
  return { svg: out.join(""), h: cy - y + rowH };
}

/** 데이터 → SVG. 크기는 viewBox 기준(카드에서 폭 % 로 줄어든다). */
export function buildChartSvg(spec: ChartSpec): string {
  switch (spec.type) {
    case "radar":
      return radarSvg(spec);
    case "bubble":
      return bubbleSvg(spec);
    case "venn":
      return vennSvg(spec);
    case "hbar100":
      return hbar100Svg(spec);
    case "dotrange":
      return dotrangeSvg(spec);
    default:
      return xySvg(spec);
  }
}

/* ---------- 세로 축 그래프(bar · stacked · line · area) ---------- */
function xySvg(spec: ChartSpec): string {
  const W = spec.width ?? 340;
  const H = spec.height ?? 230;
  const cats = spec.categories;
  const series = spec.series.map((s, i) => ({ ...s, fill: s.fill ?? DEFAULT_FILLS[i % DEFAULT_FILLS.length] }));
  const left = series.filter((s) => s.axis !== "right");
  const right = series.filter((s) => s.axis === "right");
  const stacked = spec.type === "stacked" || spec.type === "area";
  const leftVals = stacked
    ? cats.map((_, ci) => left.reduce((a, s) => a + (s.values[ci] ?? 0), 0))
    : left.flatMap((s) => s.values.filter((v): v is number => v != null));
  const ya = axisRange(leftVals, spec.yMin, spec.yMax, spec.yStep);
  const y2 = right.length ? axisRange(right.flatMap((s) => s.values.filter((v): v is number => v != null)), spec.y2Min, spec.y2Max, spec.y2Step) : null;
  const PL = 44;
  const PR = y2 ? 44 : 14;
  const PT = 26;
  const hasGroups = !!spec.groups?.some(Boolean);
  const legendItems = series.map((s) => ({ name: s.name, fill: s.fill, marker: s.as === "dot" ? s.marker ?? "dot" : undefined, line: s.as === "line" || (spec.type === "line" && s.as !== "bar") }));
  const showLegend = spec.legend !== "none" && series.length > 1;
  const PB = 22 + (hasGroups ? 14 : 0) + (spec.xLabel ? 14 : 0) + (showLegend ? 22 : 0);
  const pw = W - PL - PR;
  const ph = H - PT - PB;
  const yOf = (v: number) => PT + ph - ((v - ya.lo) / (ya.hi - ya.lo)) * ph;
  const y2Of = (v: number) => (y2 ? PT + ph - ((v - y2.lo) / (y2.hi - y2.lo)) * ph : 0);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, defs(), `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.title) out.push(text(W / 2, 13, spec.title, { size: 12, weight: 700 }));
  // 축
  out.push(`<rect x="${PL}" y="${PT}" width="${pw}" height="${ph}" fill="none" stroke="#000" stroke-width="1"/>`);
  for (const t of ya.ticks) {
    const y = yOf(t);
    out.push(`<line x1="${PL - 4}" y1="${r(y)}" x2="${PL}" y2="${r(y)}" stroke="#000"/>`);
    out.push(text(PL - 6, y + 3.5, fmt(t), { size: 10, anchor: "end" }));
    if (t === 0 && ya.lo < 0) out.push(`<line x1="${PL}" y1="${r(y)}" x2="${PL + pw}" y2="${r(y)}" stroke="#000" stroke-width="0.8"/>`);
  }
  if (y2) {
    for (const t of y2.ticks) {
      const y = y2Of(t);
      out.push(`<line x1="${PL + pw}" y1="${r(y)}" x2="${PL + pw + 4}" y2="${r(y)}" stroke="#000"/>`);
      out.push(text(PL + pw + 6, y + 3.5, fmt(t), { size: 10, anchor: "start" }));
    }
  }
  if (spec.yLabel) out.push(text(PL - 4, PT - 9, spec.yLabel, { size: 10, anchor: "middle" }));
  if (spec.y2Label) out.push(text(PL + pw + 4, PT - 9, spec.y2Label, { size: 10, anchor: "middle" }));
  const n = Math.max(1, cats.length);
  const band = pw / n;
  // 범주 글자
  cats.forEach((c, i) => {
    const cx = PL + band * (i + 0.5);
    if (spec.type !== "area" && spec.type !== "line") out.push(text(cx, PT + ph + 14, c, { size: 10 }));
  });
  if (spec.type === "area" || spec.type === "line") {
    // 선형 x: 범주를 균등 간격 점으로
    const xs = cats.map((_, i) => PL + (n === 1 ? pw / 2 : (pw * i) / (n - 1)));
    cats.forEach((c, i) => c && out.push(text(xs[i], PT + ph + 14, c, { size: 10 })));
    if (spec.type === "area") {
      const acc = cats.map(() => 0);
      const polys: string[] = [];
      left.forEach((s) => {
        const lower = acc.slice();
        cats.forEach((_, i) => (acc[i] += s.values[i] ?? 0));
        const top = cats.map((_, i) => `${r(xs[i])} ${r(yOf(acc[i]))}`);
        const bot = cats.map((_, i) => `${r(xs[i])} ${r(yOf(lower[i]))}`).reverse();
        polys.push(`<path d="M${top.join("L")}L${bot.join("L")}Z" fill="${fillPaint(s.fill)}" stroke="#000" stroke-width="0.8"/>`);
      });
      out.push(...polys);
    } else {
      left.forEach((s) => {
        const pts = s.values.map((v, i) => (v == null ? null : `${r(xs[i])} ${r(yOf(v))}`)).filter(Boolean);
        out.push(`<path d="M${pts.join("L")}" fill="none" stroke="#000" stroke-width="1.4"${s.fill === "hatch" ? ' stroke-dasharray="4 3"' : ""}/>`);
        s.values.forEach((v, i) => v != null && s.marker && out.push(marker(s.marker, xs[i], yOf(v))));
      });
    }
    right.forEach((s) => s.values.forEach((v, i) => v != null && out.push(marker(s.marker ?? "dot", xs[i], y2Of(v)))));
  } else {
    const bars = left.filter((s) => s.as !== "dot" && s.as !== "line");
    const dots = [...left.filter((s) => s.as === "dot"), ...right];
    const gw = band * 0.62;
    cats.forEach((_, ci) => {
      const x0 = PL + band * ci + (band - gw) / 2;
      if (stacked) {
        let accP = 0;
        let accN = 0;
        bars.forEach((s) => {
          const v = s.values[ci] ?? 0;
          const from = v >= 0 ? accP : accN;
          const to = from + v;
          if (v >= 0) accP = to;
          else accN = to;
          const ya0 = yOf(from);
          const ya1 = yOf(to);
          out.push(`<rect x="${r(x0)}" y="${r(Math.min(ya0, ya1))}" width="${r(gw)}" height="${r(Math.abs(ya1 - ya0))}" fill="${fillPaint(s.fill)}" stroke="#000" stroke-width="0.8"/>`);
        });
      } else {
        const bw = gw / Math.max(1, bars.length);
        bars.forEach((s, si) => {
          const v = s.values[ci];
          if (v == null) return;
          const base = yOf(Math.max(ya.lo, Math.min(0, ya.hi)));
          const yv = yOf(v);
          out.push(`<rect x="${r(x0 + bw * si)}" y="${r(Math.min(base, yv))}" width="${r(bw)}" height="${r(Math.abs(base - yv))}" fill="${fillPaint(s.fill)}" stroke="#000" stroke-width="0.8"/>`);
        });
      }
      dots.forEach((s) => {
        const v = s.values[ci];
        if (v == null) return;
        const cx = PL + band * (ci + 0.5);
        out.push(marker(s.marker ?? "dot", cx, s.axis === "right" ? y2Of(v) : yOf(v)));
      });
    });
  }
  let y = PT + ph + 14;
  if (hasGroups) {
    // 두 범주씩 묶는 아래 줄(예: 1월 7월 → (가))
    const groups = spec.groups!;
    let i = 0;
    while (i < groups.length) {
      let j = i;
      while (j + 1 < groups.length && (groups[j + 1] === "" || groups[j + 1] === groups[i])) j++;
      const xA = PL + band * i;
      const xB = PL + band * (j + 1);
      if (groups[i]) out.push(text((xA + xB) / 2, y + 14, groups[i], { size: 10.5 }));
      i = j + 1;
    }
    y += 14;
  }
  if (spec.xLabel) {
    out.push(text(PL + pw / 2, y + 14, spec.xLabel, { size: 10 }));
    y += 14;
  }
  if (showLegend) {
    const lg = legendSvg(legendItems, PL, y + 18, pw);
    out.push(lg.svg);
  }
  out.push("</svg>");
  return out.join("");
}

/* ---------- 가로 100% 누적 막대(연도별 구성비) ---------- */
function hbar100Svg(spec: ChartSpec): string {
  const cats = spec.categories;
  const series = spec.series.map((s, i) => ({ ...s, fill: s.fill ?? DEFAULT_FILLS[i % DEFAULT_FILLS.length] }));
  const W = spec.width ?? 320;
  const rowH = 14;
  const PL = 40;
  const PR = 26;
  const PT = 24;
  const ph = cats.length * rowH;
  const showLegend = spec.legend !== "none";
  const H = spec.height ?? PT + ph + 26 + (showLegend ? 24 : 0);
  const pw = W - PL - PR;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, defs(), `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.title) out.push(text(W / 2, 13, spec.title, { size: 11.5, weight: 700 }));
  if (spec.yLabel) out.push(text(PL - 6, PT - 6, spec.yLabel, { size: 10, anchor: "end" }));
  cats.forEach((c, ci) => {
    const total = series.reduce((a, s) => a + Math.max(0, s.values[ci] ?? 0), 0) || 1;
    let acc = 0;
    const y = PT + rowH * ci;
    series.forEach((s) => {
      const v = Math.max(0, s.values[ci] ?? 0) / total;
      out.push(`<rect x="${r(PL + pw * acc)}" y="${r(y)}" width="${r(pw * v)}" height="${rowH}" fill="${fillPaint(s.fill)}" stroke="#000" stroke-width="0.4"/>`);
      acc += v;
    });
    if (c) out.push(text(PL - 5, y + rowH - 3, c, { size: 9.5, anchor: "end" }));
  });
  out.push(`<rect x="${PL}" y="${PT}" width="${pw}" height="${ph}" fill="none" stroke="#000"/>`);
  for (let p = 0; p <= 100; p += 20) {
    const x = PL + (pw * p) / 100;
    out.push(`<line x1="${r(x)}" y1="${PT + ph}" x2="${r(x)}" y2="${PT + ph + 4}" stroke="#000"/>`, text(x, PT + ph + 15, String(p), { size: 9.5 }));
  }
  out.push(text(PL + pw + 9, PT + ph + 15, spec.xLabel ?? "(%)", { size: 9.5, anchor: "start" }));
  if (showLegend) out.push(legendSvg(series.map((s) => ({ name: s.name, fill: s.fill })), PL, PT + ph + 38, pw).svg);
  out.push("</svg>");
  return out.join("");
}

/* ---------- 두 시점 점 + 선(가로) ---------- */
function dotrangeSvg(spec: ChartSpec): string {
  const cats = spec.categories;
  const W = spec.width ?? 380;
  const rowH = 26;
  const PL = 70;
  const PR = 16;
  const PT = spec.title ? 34 : 14;
  const ph = cats.length * rowH;
  const H = spec.height ?? PT + ph + 44;
  const pw = W - PL - PR;
  const all = spec.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const xa = axisRange(all, spec.xMin, spec.xMax, spec.xStep);
  const xOf = (v: number) => PL + ((v - xa.lo) / (xa.hi - xa.lo)) * pw;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, defs(), `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.title) out.push(text(W / 2, 14, spec.title, { size: 11.5, weight: 700 }));
  out.push(`<line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + ph}" stroke="#000"/><line x1="${PL}" y1="${PT + ph}" x2="${PL + pw}" y2="${PT + ph}" stroke="#000"/>`);
  for (const t of xa.ticks) {
    const x = xOf(t);
    out.push(`<line x1="${r(x)}" y1="${PT}" x2="${r(x)}" y2="${PT + ph}" stroke="#bbb" stroke-dasharray="2 2"/>`, text(x, PT + ph + 14, fmt(t), { size: 9.5 }));
  }
  const mks: Marker[] = ["triangle", "squareFill", "circle", "dot"];
  cats.forEach((c, ci) => {
    const y = PT + rowH * (ci + 0.5);
    out.push(text(PL - 6, y + 3.5, c, { size: 10, anchor: "end" }));
    const vs = spec.series.map((s) => s.values[ci]).filter((v): v is number => v != null);
    if (vs.length >= 2) out.push(`<line x1="${r(xOf(Math.min(...vs)))}" y1="${r(y)}" x2="${r(xOf(Math.max(...vs)))}" y2="${r(y)}" stroke="#000" stroke-width="1.2"/>`);
    spec.series.forEach((s, si) => {
      const v = s.values[ci];
      if (v != null) out.push(marker(s.marker ?? mks[si % mks.length], xOf(v), y));
    });
  });
  out.push(legendSvg(spec.series.map((s, si) => ({ name: s.name, marker: s.marker ?? mks[si % mks.length] })), PL + pw / 3, PT + ph + 32, pw).svg);
  out.push("</svg>");
  return out.join("");
}

/* ---------- 방사형(여러 개 나란히) ---------- */
function radarSvg(spec: ChartSpec): string {
  // categories = 축 이름(꼭짓점), series = 그래프 하나씩(name 이 그래프 제목). yMax = 축 최댓값(바깥쪽이 작은 값이 되게 하려면 extra.reverse="1").
  const axes = spec.categories;
  const n = Math.max(3, axes.length);
  const count = Math.max(1, spec.series.length);
  const R = 34;
  const cell = R * 2 + 30;
  const W = spec.width ?? cell * count + 10;
  const H = spec.height ?? cell + 40;
  const max = spec.yMax ?? Math.max(1, ...spec.series.flatMap((s) => s.values.filter((v): v is number => v != null)));
  const reverse = spec.extra?.reverse === "1";
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, defs(), `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.title) out.push(text(W / 2, 12, spec.title, { size: 11, weight: 700 }));
  spec.series.forEach((s, si) => {
    const cx = 5 + cell * si + cell / 2;
    const cy = (spec.title ? 22 : 8) + 30 + R;
    out.push(text(cx, cy - R - 24, s.name, { size: 10.5, weight: 700 }));
    const pt = (k: number, frac: number) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
      return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
    };
    for (const f of [1, 0.5]) {
      const ring = Array.from({ length: n }, (_, k) => pt(k, f).map(r).join(" "));
      out.push(`<path d="M${ring.join("L")}Z" fill="none" stroke="#000" stroke-width="${f === 1 ? 0.9 : 0.5}"/>`);
    }
    for (let k = 0; k < n; k++) {
      const [x, y] = pt(k, 1);
      out.push(`<line x1="${r(cx)}" y1="${r(cy)}" x2="${r(x)}" y2="${r(y)}" stroke="#000" stroke-width="0.4"/>`);
      if (si === 0 || spec.extra?.labelsEach === "1") {
        const [lx, ly] = pt(k, 1.28);
        out.push(text(lx, ly + 3, axes[k] ?? "", { size: 8.5 }));
      }
    }
    const poly = s.values.slice(0, n).map((v, k) => {
      const f = Math.max(0, Math.min(1, (v ?? 0) / max));
      return pt(k, reverse ? 1 - f + 1 / max : f).map(r).join(" ");
    });
    out.push(`<path d="M${poly.join("L")}Z" fill="${fillPaint(s.fill ?? "light")}" fill-opacity="0.85" stroke="#000" stroke-width="1.3"/>`);
    s.values.slice(0, n).forEach((v, k) => {
      if (v == null || spec.extra?.values !== "1") return;
      const f = Math.max(0, Math.min(1, v / max));
      const [x, y] = pt(k, reverse ? 1 - f + 1 / max : f);
      out.push(text(x, y - 3, fmt(v), { size: 8 }));
    });
  });
  if (spec.note) out.push(text(6, H - 4, spec.note, { size: 9, anchor: "start" }));
  out.push("</svg>");
  return out.join("");
}

/* ---------- 거품 ---------- */
function bubbleSvg(spec: ChartSpec): string {
  // series 하나 = 거품 하나: name=이름, values=[x, y, 크기], fill.
  const W = spec.width ?? 380;
  const H = spec.height ?? 300;
  const PL = 44;
  const PR = 16;
  const PT = 26;
  const PB = 40;
  const pw = W - PL - PR;
  const ph = H - PT - PB;
  const xs = spec.series.map((s) => s.values[0] ?? 0);
  const ys = spec.series.map((s) => s.values[1] ?? 0);
  const ss = spec.series.map((s) => Math.max(0, s.values[2] ?? 1));
  // 거품이 가장자리에서 잘리지 않게 값 범위를 양쪽으로 넓혀 잡는다
  const spread = (v: number[]) => {
    const lo = Math.min(...v), hi = Math.max(...v);
    const m = (hi - lo || Math.abs(hi) || 1) * 0.18;
    return [lo - m, hi + m];
  };
  const xa = axisRange(spread(xs), spec.xMin, spec.xMax, spec.xStep, false);
  const ya = axisRange(spread(ys).map((v) => Math.max(0, v)), spec.yMin, spec.yMax, spec.yStep);
  const smax = Math.max(1, ...ss);
  const rMax = Math.min(pw, ph) * 0.11;
  const xOf = (v: number) => PL + ((v - xa.lo) / (xa.hi - xa.lo)) * pw;
  const yOf = (v: number) => PT + ph - ((v - ya.lo) / (ya.hi - ya.lo)) * ph;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, defs(), `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (spec.title) out.push(text(W / 2, 13, spec.title, { size: 11.5, weight: 700 }));
  out.push(`<line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + ph}" stroke="#000"/><line x1="${PL}" y1="${PT + ph}" x2="${PL + pw}" y2="${PT + ph}" stroke="#000"/>`);
  for (const t of ya.ticks) out.push(text(PL - 5, yOf(t) + 3.5, fmt(t), { size: 9.5, anchor: "end" }), `<line x1="${PL - 3}" y1="${r(yOf(t))}" x2="${PL}" y2="${r(yOf(t))}" stroke="#000"/>`);
  for (const t of xa.ticks) out.push(text(xOf(t), PT + ph + 13, fmt(t), { size: 9.5 }), `<line x1="${r(xOf(t))}" y1="${PT + ph}" x2="${r(xOf(t))}" y2="${PT + ph + 3}" stroke="#000"/>`);
  if (spec.yLabel) out.push(text(PL - 8, PT - 12, spec.yLabel, { size: 10, anchor: "end" }));
  if (spec.xLabel) out.push(text(PL + pw / 2, PT + ph + 28, spec.xLabel, { size: 10 }));
  const order = spec.series.map((s, i) => i).sort((a, b) => ss[b] - ss[a]);
  for (const i of order) {
    const s = spec.series[i];
    const rad = Math.max(3, rMax * Math.sqrt(ss[i] / smax));
    const x = xOf(xs[i]);
    const y = yOf(ys[i]);
    out.push(`<circle cx="${r(x)}" cy="${r(y)}" r="${r(rad)}" fill="${fillPaint(s.fill ?? "white")}" stroke="#000" stroke-width="1"/>`);
    if (s.name) out.push(text(x + rad + 3, y - rad * 0.4, s.name, { size: 10, anchor: "start" }));
  }
  if (spec.note) out.push(text(PL, H - 4, spec.note, { size: 9, anchor: "start" }));
  out.push("</svg>");
  return out.join("");
}

/* ---------- 벤 다이어그램 ---------- */
function vennSvg(spec: ChartSpec): string {
  // categories = 원 이름 2~3개. extra: { A:"A", B:"B", C:"C", AB:"", ... } 영역 글자(원 이름 첫 글자 기준 키: 1,2,3,12,13,23,123).
  const names = spec.categories.slice(0, 3);
  const three = names.length >= 3;
  const W = spec.width ?? 260;
  const H = spec.height ?? (three ? 230 : 160);
  const R = three ? 60 : 62;
  const cs = three
    ? [
        [W / 2 - 36, 92],
        [W / 2 + 36, 92],
        [W / 2, 150],
      ]
    : [
        [W / 2 - 40, H / 2 + 6],
        [W / 2 + 40, H / 2 + 6],
      ];
  const e = spec.extra ?? {};
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="#fff"/>`];
  cs.forEach(([x, y]) => out.push(`<circle cx="${r(x)}" cy="${r(y)}" r="${R}" fill="none" stroke="#000" stroke-width="1.2"/>`));
  cs.forEach(([x, y], i) => {
    const ty = three && i === 2 ? y + R + 13 : y - R - 5;
    out.push(text(x + (three ? 0 : i === 0 ? -14 : 14), ty, names[i] ?? "", { size: 11 }));
  });
  const place = (k: string, x: number, y: number) => {
    if (e[k]) out.push(`<circle cx="${r(x)}" cy="${r(y - 4)}" r="9" fill="#fff" stroke="#000" stroke-width="0.8"/>`, text(x, y, e[k], { size: 11 }));
  };
  if (three) {
    place("1", cs[0][0] - 26, cs[0][1] - 10);
    place("2", cs[1][0] + 26, cs[1][1] - 10);
    place("3", cs[2][0], cs[2][1] + 30);
    place("12", W / 2, cs[0][1] - 26);
    place("13", W / 2 - 40, 140);
    place("23", W / 2 + 40, 140);
    place("123", W / 2, 116);
  } else {
    place("1", cs[0][0] - 28, cs[0][1] + 4);
    place("2", cs[1][0] + 28, cs[1][1] + 4);
    place("12", W / 2, cs[0][1] + 4);
  }
  out.push("</svg>");
  return out.join("");
}

/* ---------- 손으로 적기 쉬운 표 글 ↔ spec ---------- */

/**
 * 데이터 칸(쉼표·탭 구분 표 글)을 categories/series 로. 첫 줄 = 머리(첫 칸은 범주 이름, 나머지는 계열 이름),
 * 다음 줄마다 범주 하나. bubble 은 "이름, x, y, 크기", radar 는 첫 줄 = 축 이름, 다음 줄 = 그래프 하나(이름, 값…).
 */
export function parseTable(src: string): string[][] {
  return src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\t|,/).map((c) => c.trim()));
}
const numOrNull = (s: string | undefined) => {
  if (s == null || s === "" || s === "-") return null;
  const v = Number(s.replace(/[^\d.+-eE]/g, ""));
  return Number.isFinite(v) ? v : null;
};

export function specFromTable(type: ChartType, rows: string[][], prev?: ChartSpec): ChartSpec {
  const base: ChartSpec = { ...(prev ?? { categories: [], series: [] }), type };
  const keep = (i: number) => prev?.series[i];
  if (type === "bubble") {
    return {
      ...base,
      categories: [],
      series: rows.slice(rows[0] && isNaN(Number(rows[0][1])) ? 1 : 0).map((row, i) => ({
        name: row[0] ?? "",
        values: [numOrNull(row[1]), numOrNull(row[2]), numOrNull(row[3])],
        fill: (row[4] as Fill) && FILLS.includes(row[4] as Fill) ? (row[4] as Fill) : keep(i)?.fill,
      })),
    };
  }
  if (type === "radar") {
    const [head, ...rest] = rows;
    return {
      ...base,
      categories: (head ?? []).slice(1),
      series: rest.map((row, i) => ({ name: row[0] ?? "", values: row.slice(1).map(numOrNull), fill: keep(i)?.fill })),
    };
  }
  if (type === "venn") {
    const [head, ...rest] = rows;
    const extra: Record<string, string> = {};
    for (const row of rest) if (row[0]) extra[row[0]] = row[1] ?? "";
    return { ...base, categories: (head ?? []).filter(Boolean), series: [], extra: { ...extra } };
  }
  const [head, ...rest] = rows;
  const names = (head ?? []).slice(1);
  return {
    ...base,
    categories: rest.map((row) => row[0] ?? ""),
    series: names.map((name, si) => ({ ...(keep(si) ?? {}), name, values: rest.map((row) => numOrNull(row[si + 1])) })),
  };
}

export function tableFromSpec(spec: ChartSpec): string {
  if (spec.type === "bubble") return ["이름, x, y, 크기, 칠하기", ...spec.series.map((s) => [s.name, ...s.values.map((v) => v ?? ""), s.fill ?? ""].join(", "))].join("\n");
  if (spec.type === "radar") return [["그래프", ...spec.categories].join(", "), ...spec.series.map((s) => [s.name, ...s.values.map((v) => v ?? "")].join(", "))].join("\n");
  if (spec.type === "venn") return [spec.categories.join(", "), ...Object.entries(spec.extra ?? {}).map(([k, v]) => `${k}, ${v}`)].join("\n");
  return [["범주", ...spec.series.map((s) => s.name)].join(", "), ...spec.categories.map((c, i) => [c, ...spec.series.map((s) => s.values[i] ?? "")].join(", "))].join("\n");
}

export function readChartSpec(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const types: ChartType[] = ["bar", "stacked", "hbar100", "line", "area", "dotrange", "radar", "bubble", "venn"];
  if (!types.includes(o.type as ChartType)) return null;
  const s = (v: unknown, n = 80) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const cats = Array.isArray(o.categories) ? o.categories.slice(0, 60).map((c) => String(c ?? "").slice(0, 40)) : [];
  const series: ChartSeries[] = Array.isArray(o.series)
    ? o.series.slice(0, 24).map((x) => {
        const q = (x ?? {}) as Record<string, unknown>;
        return {
          name: String(q.name ?? "").slice(0, 40),
          values: Array.isArray(q.values) ? q.values.slice(0, 60).map((v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null)) : [],
          fill: FILLS.includes(q.fill as Fill) ? (q.fill as Fill) : undefined,
          marker: MARKERS.includes(q.marker as Marker) ? (q.marker as Marker) : undefined,
          axis: q.axis === "right" ? "right" : undefined,
          as: q.as === "dot" || q.as === "line" || q.as === "bar" ? q.as : undefined,
        };
      })
    : [];
  const extra: Record<string, string> = {};
  if (o.extra && typeof o.extra === "object") for (const [k, v] of Object.entries(o.extra as Record<string, unknown>).slice(0, 20)) extra[k.slice(0, 10)] = String(v ?? "").slice(0, 20);
  return {
    type: o.type as ChartType,
    title: s(o.title),
    yLabel: s(o.yLabel),
    y2Label: s(o.y2Label),
    xLabel: s(o.xLabel),
    categories: cats,
    groups: Array.isArray(o.groups) ? o.groups.slice(0, 60).map((g) => String(g ?? "").slice(0, 20)) : undefined,
    series,
    yMin: n(o.yMin),
    yMax: n(o.yMax),
    yStep: n(o.yStep),
    y2Min: n(o.y2Min),
    y2Max: n(o.y2Max),
    y2Step: n(o.y2Step),
    xMin: n(o.xMin),
    xMax: n(o.xMax),
    xStep: n(o.xStep),
    legend: o.legend === "none" || o.legend === "right" ? o.legend : undefined,
    note: s(o.note, 120),
    extra,
    width: n(o.width),
    height: n(o.height),
  };
}
