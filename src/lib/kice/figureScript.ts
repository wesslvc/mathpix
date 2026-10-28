/**
 * **도식 스크립트** — sol 이 좌표를 눈어림하는 대신 **짧은 코드(함수·반복·삼각함수)** 로 도식을 쓰고, 이 모듈이 라이브러리(`fig`)와 함께
 * 격리된 환경에서 실행해 평가원 규격의 그리기 명령(`FigureOps`)으로 돌려준다. 값은 계산으로 정해지므로 눈금·개수·위치가 정확하다.
 *
 * 격리: Node `vm` 의 빈 컨텍스트(전역·모듈·네트워크 없음), 실행 시간 제한, 그리기 명령 수 제한. **서버 전용**이다. 운영에서는 더 강한 격리(QuickJS
 * 등)로 바꿀 것 — `vm` 은 악의적인 코드에 대한 보안 경계가 아니다(여기서는 sol 이 쓴 코드를 돌리는 용도라 위험이 낮지만 같지는 않다).
 */
import vm from "node:vm";
import { contourLines } from "./contourField";
import { clipHalf, patternOps, smooth, renderFigure, type FigOp, type FigureOps, type FigureSpec, type PatternKind, type Pt } from "./figureDsl";

const MAX_OPS = 60000;

type Style = { th?: number; dash?: [number, number]; fill?: number; stroke?: number };

export function runFigureScript(code: string, opts: { timeoutMs?: number } = {}): FigureOps {
  let W = 1000;
  let H = 600;
  const root: FigOp[] = [];
  let ops = root;
  const push = (o: FigOp) => {
    if (root.length > MAX_OPS) throw new Error("그리기 명령이 너무 많음");
    ops.push(o);
  };
  const num = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} 은 유한한 숫자여야 함`);
    return v;
  };
  const pts = (p: unknown): Pt[] => {
    if (!Array.isArray(p)) throw new Error("점 목록이 필요함");
    return p.map((q) => [num(q[0], "x"), num(q[1], "y")] as Pt);
  };

  const fig = {
    size(w: number, h: number) { W = num(w, "w"); H = num(h, "h"); },
    line(p: Pt[], o: Style = {}) { push({ t: "line", pts: pts(p), th: o.th ?? 1.7, dash: o.dash }); },
    poly(p: Pt[], o: Style = {}) { push({ t: "poly", pts: pts(p), fill: o.fill, stroke: o.stroke, dash: o.dash, close: true }); },
    rect(x: number, y: number, w: number, h: number, o: Style = {}) { push({ t: "rect", x, y, w, h, fill: o.fill, stroke: o.stroke }); },
    circle(x: number, y: number, r: number, o: Style = {}) {
      const p: Pt[] = Array.from({ length: 48 }, (_, i) => [x + r * Math.cos((i / 48) * 2 * Math.PI), y + r * Math.sin((i / 48) * 2 * Math.PI)]);
      push({ t: "poly", pts: p, fill: o.fill, stroke: o.stroke, close: true });
    },
    dot(x: number, y: number, r = 3, gray = 0) { push({ t: "ellipse", x, y, rx: r, ry: r, fill: gray }); },
    text(x: number, y: number, s: string, o: { size?: number; italic?: boolean; anchor?: "l" | "c" | "r"; bold?: boolean; vertical?: boolean } = {}) {
      push({ t: "text", x, y, s: String(s), size: o.size ?? 30, italic: o.italic, anchor: o.anchor, bold: o.bold, vertical: o.vertical });
    },
    circled(x: number, y: number, ch: string, size = 36) { push({ t: "circ", x, y, ch, size }); },
    /** 다각형 안에서만 보이게 그린다. */
    clip(poly: Pt[], fn: () => void) {
      const outer = ops;
      const inner: FigOp[] = [];
      ops = inner;
      try { fn(); } finally { ops = outer; }
      push({ t: "group", clip: pts(poly), ops: inner });
    },
    /** 다각형을 무늬로 채운다(plus·v·dots·brick·hlines). */
    pattern(kind: PatternKind, poly: Pt[]) {
      const p = pts(poly);
      push({ t: "group", clip: p, ops: patternOps(kind, p) });
    },
    /** 다각형을 직선 (a→b) 의 한쪽(+1 왼쪽/-1 오른쪽)으로 자른다. */
    clipPoly(poly: Pt[], a: Pt, b: Pt, side: 1 | -1) { return clipHalf(pts(poly), a, b, side); },
    smooth(p: Pt[], n = 1) { return smooth(pts(p), n); },
    /** 점들을 매끄럽게 지나는 함수 y = f(x)(Catmull-Rom, x 는 오름차순). 범위 밖은 끝값. */
    spline(p: Pt[]) {
      const q = [...pts(p)].sort((a, b) => a[0] - b[0]);
      return (x: number) => {
        if (x <= q[0][0]) return q[0][1];
        if (x >= q[q.length - 1][0]) return q[q.length - 1][1];
        let i = 1;
        while (q[i][0] < x) i++;
        const p0 = q[Math.max(0, i - 2)];
        const p1 = q[i - 1];
        const p2 = q[i];
        const p3 = q[Math.min(q.length - 1, i + 1)];
        const t = (x - p1[0]) / (p2[0] - p1[0] || 1);
        const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * (p2[0] - p1[0]);
        const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * (p2[0] - p1[0]);
        const t2 = t * t;
        const t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
      };
    },
    /**
     * 장 f(x,y) 의 등치선을 뽑아 규격대로 그린다(0 은 굵게, 음수는 점선). 영역 [x0,x1]×[y0,y1], 결과 좌표는 `map(x,y)` 로 옮긴다.
     * 그리지 않고 선만 받으려면 `draw:false`.
     */
    contour(
      f: (x: number, y: number) => number,
      o: { x0: number; x1: number; y0: number; y1: number; levels: number[]; map: (x: number, y: number) => Pt; nx?: number; ny?: number; draw?: boolean; thZero?: number; thin?: number; dash?: [number, number]; smoothing?: number },
    ) {
      const nx = o.nx ?? 360;
      const ny = o.ny ?? 150;
      const res: { level: number; pts: Pt[] }[] = [];
      const g = (u: number, v: number) => f(o.x0 + u * (o.x1 - o.x0), o.y0 + v * (o.y1 - o.y0));
      for (const L of o.levels) {
        for (const line of contourLines(g, L, nx, ny)) {
          const mapped = smooth(line, o.smoothing ?? 1).map(([u, v]) => o.map(o.x0 + u * (o.x1 - o.x0), o.y0 + v * (o.y1 - o.y0)));
          res.push({ level: L, pts: mapped });
          if (o.draw !== false) push({ t: "line", pts: mapped, th: L === 0 ? o.thZero ?? 5.2 : o.thin ?? 1.7, ...(L < 0 ? { dash: o.dash ?? [9, 6] } : {}) });
        }
      }
      return res;
    },
    /** y = f(x) 곡선을 그린다. */
    plot(f: (x: number) => number, x0: number, x1: number, o: { map: (x: number, y: number) => Pt; n?: number; th?: number; dash?: [number, number] }) {
      const n = o.n ?? 200;
      const p: Pt[] = Array.from({ length: n + 1 }, (_, i) => o.map(x0 + ((x1 - x0) * i) / n, f(x0 + ((x1 - x0) * i) / n)));
      push({ t: "line", pts: p, th: o.th ?? 2, dash: o.dash });
      return p;
    },
    /** 이미 있는 DSL 스펙을 (dx,dy) 에 scale 배로 끼워 넣는다. */
    embed(spec: FigureSpec, dx = 0, dy = 0, scale = 1) {
      const r = renderFigure(spec);
      const mv = (os: FigOp[]): FigOp[] =>
        os.map((op): FigOp => {
          switch (op.t) {
            case "poly":
            case "line": return { ...op, pts: op.pts.map(([x, y]) => [dx + x * scale, dy + y * scale] as Pt), ...("th" in op ? { th: op.th * scale } : {}) } as FigOp;
            case "group": return { ...op, clip: op.clip.map(([x, y]) => [dx + x * scale, dy + y * scale] as Pt), ops: mv(op.ops) };
            case "rect": return { ...op, x: dx + op.x * scale, y: dy + op.y * scale, w: op.w * scale, h: op.h * scale };
            case "ellipse": return { ...op, x: dx + op.x * scale, y: dy + op.y * scale, rx: op.rx * scale, ry: op.ry * scale };
            default: return { ...op, x: dx + op.x * scale, y: dy + op.y * scale, size: op.size * scale };
          }
        });
      for (const o of mv(r.ops)) push(o);
      return { w: r.w * scale, h: r.h * scale };
    },
    rand: (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); })(),
  };

  const sandbox = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  (sandbox as { fig?: unknown }).fig = fig;
  (sandbox as { Math?: unknown }).Math = Math;
  vm.runInContext(`"use strict";\n${code}`, sandbox, { timeout: opts.timeoutMs ?? 3000 });
  return { w: W, h: H, ops: root };
}
