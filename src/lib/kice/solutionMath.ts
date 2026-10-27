/**
 * 해설 속 수식(`$…$` LaTeX)을 **글자 윤곽(벡터)** 으로 바꾼다 — MathJax(SVG 출력)를 DOM 없이(liteAdaptor) 돌려서, 화면을 사진 찍는
 * 방식(html-to-image)과 달리 웹 워커에서도 되고 수백 개도 금방이다. 결과는 PDF 에 `drawSvgPath` 로 그대로 그린다.
 *
 * 좌표는 **em 단위, y 가 아래로**, 원점은 줄의 글자 기준선 왼쪽 끝이다.
 */
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor, type LiteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import "mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js";

export type MathBox = {
  /** 폭(em). */
  w: number;
  /** 기준선 위로 올라온 높이(em). */
  asc: number;
  /** 기준선 아래로 내려간 깊이(em). */
  desc: number;
  /** 변환이 끝난 SVG path(em 단위, y 아래로). 합쳐서 한 번에 그린다. */
  d: string;
};

type Mat = [number, number, number, number, number, number];
const ID: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(t: string | undefined): Mat {
  let m = ID;
  if (!t) return m;
  for (const part of t.matchAll(/(translate|scale|matrix)\(([^)]*)\)/g)) {
    const n = part[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (part[1] === "translate") m = mul(m, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]);
    else if (part[1] === "scale") m = mul(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]);
    else if (n.length === 6) m = mul(m, n as Mat);
  }
  return m;
}

const fmt = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

/** path 데이터 하나를 행렬로 옮겨 절대좌표 M L C Q Z 로 돌려준다(MathJax 글리프는 이 명령들만 쓴다). */
function transformPath(d: string, m: Mat, scale: number): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  const out: string[] = [];
  const num = () => Number(tokens[i++]);
  const P = (x: number, y: number) => {
    const [tx, ty] = apply(m, x, y);
    return `${fmt(tx * scale)} ${fmt(ty * scale)}`;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") {
      out.push("Z");
      cx = sx;
      cy = sy;
      lastCtrl = lastQ = null;
      continue;
    }
    if (C === "M") {
      let x = num();
      let y = num();
      if (rel) { x += cx; y += cy; }
      out.push(`M${P(x, y)}`);
      cx = sx = x;
      cy = sy = y;
      cmd = rel ? "l" : "L";
      lastCtrl = lastQ = null;
    } else if (C === "L") {
      let x = num();
      let y = num();
      if (rel) { x += cx; y += cy; }
      out.push(`L${P(x, y)}`);
      cx = x;
      cy = y;
      lastCtrl = lastQ = null;
    } else if (C === "H") {
      let x = num();
      if (rel) x += cx;
      out.push(`L${P(x, cy)}`);
      cx = x;
      lastCtrl = lastQ = null;
    } else if (C === "V") {
      let y = num();
      if (rel) y += cy;
      out.push(`L${P(cx, y)}`);
      cy = y;
      lastCtrl = lastQ = null;
    } else if (C === "C" || C === "S") {
      let x1: number, y1: number;
      if (C === "C") {
        x1 = num(); y1 = num();
        if (rel) { x1 += cx; y1 += cy; }
      } else {
        [x1, y1] = lastCtrl ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
      }
      let x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
      out.push(`C${P(x1, y1)} ${P(x2, y2)} ${P(x, y)}`);
      lastCtrl = [x2, y2];
      lastQ = null;
      cx = x;
      cy = y;
    } else if (C === "Q" || C === "T") {
      let x1: number, y1: number;
      if (C === "Q") {
        x1 = num(); y1 = num();
        if (rel) { x1 += cx; y1 += cy; }
      } else {
        [x1, y1] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
      }
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      out.push(`Q${P(x1, y1)} ${P(x, y)}`);
      lastQ = [x1, y1];
      lastCtrl = null;
      cx = x;
      cy = y;
    } else {
      // 지원하지 않는 명령(호 등) — 이 도형은 건너뛴다.
      return "";
    }
  }
  return out.join("");
}

let ready: { adaptor: LiteAdaptor; doc: ReturnType<typeof mathjax.document> } | null = null;
function engine() {
  if (!ready) {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const doc = mathjax.document("", {
      InputJax: new TeX({ packages: ["base", "ams", "newcommand", "noundefined"] }),
      OutputJax: new SVG({ fontCache: "none" }),
    });
    ready = { adaptor, doc };
  }
  return ready;
}

const cache = new Map<string, MathBox | null>();

/** LaTeX 한 덩어리를 윤곽으로. 한글 등 MathJax 글꼴에 없는 글자가 있거나 오류면 null(부르는 쪽이 글자로 대신 적는다). */
export function texToMath(tex: string, display = false): MathBox | null {
  const key = (display ? "D:" : "I:") + tex;
  if (cache.has(key)) return cache.get(key)!;
  let box: MathBox | null = null;
  try {
    // MathJax SVG 는 글꼴에 없는 글자(한글 등)를 <text> 로 낸다 — 윤곽으로 못 바꾸므로 처음부터 거른다.
    if (!/[^\u0000-ɏ -⋿Ͱ-Ͽ←-⇿■-◿]/.test(tex)) {
      const { adaptor, doc } = engine();
      const node = doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 1e6 });
      box = readSvg(adaptor, node);
    }
  } catch {
    box = null;
  }
  cache.set(key, box);
  return box;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LNode = any;

function readSvg(adaptor: LiteAdaptor, root: LNode): MathBox | null {
  const find = (n: LNode): LNode | null => {
    if (adaptor.kind(n) === "svg") return n;
    for (const c of adaptor.childNodes(n)) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  const svg = find(root);
  if (!svg) return null;
  const vb: number[] = (adaptor.getAttribute(svg, "viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((v: number) => !Number.isFinite(v))) return null;
  const [minX, minY, vw, vh] = vb;
  let failed = false;
  const parts: string[] = [];
  // 뷰박스 → em: x' = (x - minX)/1000, y' = y/1000 (기준선이 y=0).
  const base: Mat = [1, 0, 0, 1, -minX, 0];
  const walk = (n: LNode, m: Mat) => {
    const kind = adaptor.kind(n);
    if (kind === "#text" || kind === "#comment") return;
    if (kind === "text") {
      failed = true;
      return;
    }
    let cur = m;
    if (kind === "svg" && n !== svg) {
      const x = Number(adaptor.getAttribute(n, "x") ?? 0);
      const y = Number(adaptor.getAttribute(n, "y") ?? 0);
      const w = Number(adaptor.getAttribute(n, "width") ?? 0);
      const h = Number(adaptor.getAttribute(n, "height") ?? 0);
      const v: number[] = (adaptor.getAttribute(n, "viewBox") ?? "").split(/[\s,]+/).map(Number);
      // 안쪽 svg 의 width/height 는 em 환산 단위(ex)가 섞여 있어 쓰지 않고 뷰박스 그대로 놓는다(x·y 만 옮긴다).
      cur = mul(cur, [1, 0, 0, 1, x, y]);
      if (v.length === 4 && v.every(Number.isFinite)) cur = mul(cur, [1, 0, 0, 1, -v[0], -v[1]]);
      void w; void h;
    } else if (kind === "g") {
      cur = mul(cur, parseTransform(adaptor.getAttribute(n, "transform") as string | undefined));
    } else if (kind === "path") {
      const d = adaptor.getAttribute(n, "d") as string | undefined;
      if (d) {
        const t = parseTransform(adaptor.getAttribute(n, "transform") as string | undefined);
        const out = transformPath(d, mul(cur, t), 1 / 1000);
        if (out) parts.push(out);
      }
      return;
    } else if (kind === "rect") {
      const x = Number(adaptor.getAttribute(n, "x") ?? 0);
      const y = Number(adaptor.getAttribute(n, "y") ?? 0);
      const w = Number(adaptor.getAttribute(n, "width") ?? 0);
      const h = Number(adaptor.getAttribute(n, "height") ?? 0);
      const t = parseTransform(adaptor.getAttribute(n, "transform") as string | undefined);
      parts.push(transformPath(`M${x} ${y}h${w}v${h}h${-w}Z`, mul(cur, t), 1 / 1000));
      return;
    } else if (kind === "use" || kind === "image") {
      failed = true;
      return;
    }
    for (const c of adaptor.childNodes(n)) walk(c, cur);
  };
  // 루트 svg 의 첫 g 에 scale(1,-1) 이 있다 — 그대로 걷는다.
  for (const c of adaptor.childNodes(svg)) walk(c, base);
  if (failed || parts.length === 0) return null;
  return { w: vw / 1000, asc: -minY / 1000, desc: (minY + vh) / 1000, d: parts.join("") };
}
