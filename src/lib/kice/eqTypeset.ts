/**
 * **수식 조판기**(평가원 문제지 수식 모양) — MathJax(TeX 서체)가 아니라 **Times 계열 글꼴**로 직접 짠다. 평가원 수식은 변수 이탤릭 ·
 * 숫자 정체 · 연산자 앞뒤 가는 공백 · 분수 막대 · 위·아래 첨자 · 소수점 아래 점 같은 규칙으로 찍힌다.
 * 순수 계산이다 — 글자 폭은 밖에서(`Metric`) 받고, 결과는 그리기 명령 목록으로 돌려준다(DOM·pdf-lib 모름).
 *
 * 지원: 영문·그리스 문자, 숫자, + − = < > ≤ ≥ ≠ × ÷ ± → ·, 위 첨자 `^`·아래 첨자 `_`·프라임 `'`, `\frac`, `\sqrt`, `\left( \right)`,
 * `\text{…}`(정체 글자, 한글 포함), 함수 이름(`\sin` 등), 공백 명령. 못 읽는 명령은 `null` 을 돌려준다(부르는 쪽이 대신 처리한다).
 */

export type Style = "r" | "i";
/** 글자 폭(pt). `s` 는 한 줄짜리 글자, style 은 정체(r)/이탤릭(i). */
export type Metric = (s: string, size: number, style: Style) => number;

export type EqOp =
  | { t: "text"; x: number; y: number; s: string; size: number; style: Style }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; th: number };

/** 좌표: x 오른쪽, **y 위쪽이 +**(기준선이 0). 단위 pt. */
export type EqBox = { w: number; asc: number; desc: number; ops: EqOp[] };

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", phi: "φ", omega: "ω", Delta: "Δ", Omega: "Ω", Sigma: "Σ", Pi: "Π", Theta: "Θ", Lambda: "Λ", Phi: "Φ",
};
const SYMBOL: Record<string, string> = {
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", times: "×", div: "÷", pm: "±", cdot: "·", to: "→", rightarrow: "→",
  degree: "°", circ: "°", infty: "∞", approx: "≈", prime: "′", ldots: "…", cdots: "⋯", mp: "∓", propto: "∝",
};
const BINARY = new Set(["+", "−", "=", "<", ">", "≤", "≥", "≠", "×", "÷", "±", "∓", "→", "≈", "∝"]);
const FUNCS = new Set(["sin", "cos", "tan", "log", "ln", "lim", "max", "min", "exp", "sec", "csc", "cot"]);

type Node =
  | { k: "ch"; s: string; style: Style; bin?: boolean }
  | { k: "text"; s: string }
  | { k: "group"; items: Node[] }
  | { k: "frac"; a: Node; b: Node }
  | { k: "sqrt"; a: Node }
  | { k: "script"; base: Node; sup?: Node; sub?: Node }
  | { k: "space"; em: number };

class Parser {
  i = 0;
  constructor(private s: string) {}
  private peek() { return this.s[this.i]; }
  private ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  parseSeq(close?: string): Node[] {
    const items: Node[] = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return items;
      const c = this.peek();
      if (close && c === close) return items;
      const atom = this.parseAtom();
      if (!atom) continue;
      items.push(this.parseScripts(atom));
    }
  }
  private parseScripts(base: Node): Node {
    let sup: Node | undefined;
    let sub: Node | undefined;
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === "^") { this.i++; sup = this.parseArg(); }
      else if (c === "_") { this.i++; sub = this.parseArg(); }
      else if (c === "'") { this.i++; sup = { k: "ch", s: "′", style: "r" }; }
      else break;
    }
    return sup || sub ? { k: "script", base, sup, sub } : base;
  }
  private parseArg(): Node {
    this.ws();
    if (this.peek() === "{") {
      this.i++;
      const items = this.parseSeq("}");
      this.i++;
      return { k: "group", items };
    }
    const a = this.parseAtom();
    return a ?? { k: "group", items: [] };
  }
  private parseAtom(): Node | null {
    const c = this.s[this.i];
    if (c === "{") { this.i++; const items = this.parseSeq("}"); this.i++; return { k: "group", items }; }
    if (c === "\\") {
      this.i++;
      const m = /^[a-zA-Z]+/.exec(this.s.slice(this.i));
      if (!m) { const sym = this.s[this.i++]; if (sym === "," || sym === ";" || sym === " " || sym === "!") return { k: "space", em: sym === "!" ? 0 : 0.17 }; return { k: "ch", s: sym, style: "r" }; }
      const name = m[0];
      this.i += name.length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") { const a = this.parseArg(); const b = this.parseArg(); return { k: "frac", a, b }; }
      if (name === "sqrt") { const a = this.parseArg(); return { k: "sqrt", a }; }
      if (name === "left" || name === "right") { this.ws(); const ch = this.s[this.i++] ?? ""; return ch === "." ? null : { k: "ch", s: ch, style: "r" }; }
      if (name === "text" || name === "mathrm" || name === "textrm") {
        this.ws();
        if (this.peek() === "{") {
          const end = this.s.indexOf("}", this.i);
          const txt = this.s.slice(this.i + 1, end < 0 ? this.s.length : end);
          this.i = end < 0 ? this.s.length : end + 1;
          return { k: "text", s: txt };
        }
        return null;
      }
      if (name === "quad") return { k: "space", em: 1 };
      if (name === "qquad") return { k: "space", em: 2 };
      if (GREEK[name]) return { k: "ch", s: GREEK[name], style: /^[A-Z]/.test(name) ? "r" : "i" };
      if (SYMBOL[name]) return { k: "ch", s: SYMBOL[name], style: "r", bin: BINARY.has(SYMBOL[name]) };
      if (FUNCS.has(name)) return { k: "text", s: name };
      throw new Error(`unsupported \\${name}`);
    }
    this.i++;
    if (/[A-Za-z]/.test(c)) return { k: "ch", s: c, style: "i" };
    if (c === "-") return { k: "ch", s: "−", style: "r", bin: true };
    return { k: "ch", s: c, style: "r", bin: BINARY.has(c) };
  }
}

type Ctx = { metric: Metric; size: number };

/** 노드 하나를 `x0`(기준선 왼쪽 끝)에 놓고 상자를 돌려준다. */
function layout(n: Node, ctx: Ctx, x0: number): EqBox {
  const { metric } = ctx;
  const size = ctx.size;
  switch (n.k) {
    case "ch": {
      const w = metric(n.s, size, n.style);
      return { w, asc: size * 0.72, desc: size * 0.2, ops: [{ t: "text", x: x0, y: 0, s: n.s, size, style: n.style }] };
    }
    case "text": {
      const w = metric(n.s, size, "r");
      return { w, asc: size * 0.72, desc: size * 0.2, ops: [{ t: "text", x: x0, y: 0, s: n.s, size, style: "r" }] };
    }
    case "space":
      return { w: n.em * size, asc: 0, desc: 0, ops: [] };
    case "group":
      return seq(n.items, ctx, x0);
    case "frac": {
      const sub: Ctx = { metric, size: size * 0.92 };
      const a = layout(n.a, sub, 0);
      const b = layout(n.b, sub, 0);
      const pad = size * 0.12;
      const w = Math.max(a.w, b.w) + pad * 2;
      const axis = size * 0.28; // 막대 높이(기준선 위)
      const gap = size * 0.14;
      const ops: EqOp[] = [{ t: "line", x1: x0, y1: axis, x2: x0 + w, y2: axis, th: Math.max(0.4, size * 0.05) }];
      const shift = (box: EqBox, dx: number, dy: number) => box.ops.map((o) => (o.t === "text" ? { ...o, x: o.x + dx, y: o.y + dy } : { ...o, x1: o.x1 + dx, x2: o.x2 + dx, y1: o.y1 + dy, y2: o.y2 + dy }));
      const ay = axis + gap + a.desc;
      const by = axis - gap - b.asc;
      ops.push(...shift(a, x0 + (w - a.w) / 2, ay), ...shift(b, x0 + (w - b.w) / 2, by));
      return { w, asc: ay + a.asc, desc: -(by - b.desc), ops };
    }
    case "sqrt": {
      const inner = layout(n.a, ctx, 0);
      const lead = size * 0.55;
      const top = Math.max(inner.asc, size * 0.72) + size * 0.16;
      const w = lead + inner.w + size * 0.08;
      const th = Math.max(0.4, size * 0.05);
      const ops: EqOp[] = [
        { t: "line", x1: x0, y1: top * 0.45, x2: x0 + lead * 0.25, y2: top * 0.5, th },
        { t: "line", x1: x0 + lead * 0.25, y1: top * 0.5, x2: x0 + lead * 0.6, y2: -inner.desc, th: th * 1.5 },
        { t: "line", x1: x0 + lead * 0.6, y1: -inner.desc, x2: x0 + lead, y2: top, th },
        { t: "line", x1: x0 + lead, y1: top, x2: x0 + w, y2: top, th },
        ...inner.ops.map((o) => (o.t === "text" ? { ...o, x: o.x + x0 + lead } : { ...o, x1: o.x1 + x0 + lead, x2: o.x2 + x0 + lead })),
      ];
      return { w, asc: top + th, desc: inner.desc, ops };
    }
    case "script": {
      const base = layout(n.base, ctx, x0);
      const isPrime = n.sup?.k === "ch" && n.sup.s === "′" && !n.sub;
      const small: Ctx = { metric, size: size * (isPrime ? 0.95 : 0.7) };
      let w = base.w;
      let asc = base.asc;
      let desc = base.desc;
      const ops = [...base.ops];
      let supBox: EqBox | undefined;
      let subBox: EqBox | undefined;
      if (n.sup) supBox = layout(n.sup, small, x0 + base.w);
      if (n.sub) subBox = layout(n.sub, small, x0 + base.w);
      const supY = size * (isPrime ? 0.16 : 0.42);
      const subY = -size * 0.2;
      if (supBox) {
        ops.push(...supBox.ops.map((o) => (o.t === "text" ? { ...o, y: o.y + supY } : { ...o, y1: o.y1 + supY, y2: o.y2 + supY })));
        asc = Math.max(asc, supY + supBox.asc);
      }
      if (subBox) {
        ops.push(...subBox.ops.map((o) => (o.t === "text" ? { ...o, y: o.y + subY } : { ...o, y1: o.y1 + subY, y2: o.y2 + subY })));
        desc = Math.max(desc, -subY + subBox.desc);
      }
      w += Math.max(supBox?.w ?? 0, subBox?.w ?? 0);
      return { w, asc, desc, ops };
    }
  }
}

function seq(items: Node[], ctx: Ctx, x0: number): EqBox {
  let x = x0;
  let asc = 0;
  let desc = 0;
  const ops: EqOp[] = [];
  items.forEach((it, idx) => {
    const isBin = it.k === "ch" && it.bin && idx > 0 && idx < items.length - 1;
    const sp = isBin ? ctx.size * 0.24 : 0;
    x += sp;
    const b = layout(it, ctx, x);
    ops.push(...b.ops);
    asc = Math.max(asc, b.asc);
    desc = Math.max(desc, b.desc);
    x += b.w + sp;
  });
  return { w: x - x0, asc, desc, ops };
}

/** LaTeX 한 덩어리를 `size`pt 로 조판한다. 못 읽으면 null. */
export function typesetEq(tex: string, size: number, metric: Metric): EqBox | null {
  try {
    const p = new Parser(tex);
    const items = p.parseSeq();
    return seq(items, { metric, size }, 0);
  } catch {
    return null;
  }
}
