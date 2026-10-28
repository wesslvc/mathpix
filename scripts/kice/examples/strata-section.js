// 20번형 지질 단면 — 수평 지층 + 부정합 + 단층(오른쪽 블록 융기) + 덩어리 관입암 A + 암맥 B. 좌표는 0~1 → 그림 폭 W 로 환산.
const W = 1000, H = 640, T = 70;
fig.size(W, H + T + 110);
const X = u => u * W, Y = v => T + v * H;
const P = ([u, v]) => [X(u), Y(v)];
const unc = u => 0.18 + 0.006 * Math.sin(u * 17) + 0.004 * Math.sin(u * 41);   // 부정합면(물결)
const fault = { a: [0.194, 0.197], b: [0.895, 1.0] }, throwV = -0.165;           // 오른쪽 블록이 올라감
const N = 80;
const layers = [{ h: 0.355, fill: 0.68 }, { h: 0.215, fill: 1, pat: "dots" }, { h: 0.25, fill: 0.9 }, { h: 0.2, fill: 1, pat: "brick" }];
const frame = [[0, T], [W, T], [W, T + H], [0, T + H]];

fig.clip(frame, () => {
  // 위: 수평 지층(가로줄)
  const top = []; for (let i = 0; i <= N; i++) top.push(P([i / N, 0]));
  const bottom = []; for (let i = N; i >= 0; i--) bottom.push(P([i / N, unc(i / N)]));
  fig.poly([...top, ...bottom], { fill: 1 });
  for (let k = 1; k <= 7; k++) fig.line([P([0, 0.18 * k / 8]), P([1, 0.18 * k / 8])], { th: 1.5 });
  // 아래: 단층 양쪽 블록을 따로 만든다
  for (const side of [1, -1]) {
    const off = side === -1 ? throwV : 0;
    let base = 0.18;
    layers.forEach((L, k) => {
      const b0 = base, b1 = base + L.h; base = b1;
      const topE = [], botE = [];
      for (let i = 0; i <= N; i++) { const u = i / N; topE.push(P([u, k === 0 ? unc(u) : Math.max(unc(u), b0 + off)])); }
      for (let i = N; i >= 0; i--) { const u = i / N; botE.push(P([u, Math.min(1.2, Math.max(unc(u), b1 + off))])); }
      const poly = fig.clipPoly([...topE, ...botE], P(fault.a), P(fault.b), side);
      if (poly.length < 3) return;
      fig.poly(poly, { fill: L.fill });
      if (L.pat) fig.pattern(L.pat, poly);
      // 아래 경계선(단층 한쪽에서만)
      const ln = []; for (let i = 0; i <= N; i++) { const u = i / N, v = b1 + off; if (v < 1 && v > unc(u) + 0.004) ln.push(P([u, v])); }
      if (ln.length > 1) fig.clip(poly, () => fig.line(ln, { th: 1.6 }));
    });
  }
  fig.line(Array.from({ length: N + 1 }, (_, i) => P([i / N, unc(i / N)])), { th: 1.7 });
  // 관입암 A(+) — 꼭짓점을 주고 Chaikin 으로 둥글린다(위는 둥근 돔, 아래로 갈수록 넓다)
  const A0 = [[0.273, 0.2], [0.29, 0.18], [0.327, 0.19], [0.44, 0.178], [0.5, 0.196], [0.553, 0.225], [0.587, 0.27], [0.58, 0.34], [0.5, 0.5], [0.45, 0.65], [0.394, 1.0], [0.206, 1.0], [0.248, 0.7], [0.271, 0.42], [0.27, 0.28]];
  const A = fig.smooth(A0.concat([A0[0]]), 2);
  fig.poly(A.map(P), { fill: 1 }); fig.pattern("plus", A.map(P)); fig.poly(A.map(P), { stroke: 1.6 });
  // 암맥 B(v) — 중심선 u(v) 과 반폭 w(v) 로 계산한 기울어진 띠
  const cx = v => 0.71 - 0.225 * (v - 0.18) / 0.82;
  const wB = v => 0.075 + 0.015 * (v - 0.18) / 0.82;
  const Bl = [], Br = [];
  for (let i = 0; i <= 24; i++) { const v = 0.18 + 0.82 * i / 24; Bl.push([cx(v) - wB(v), v]); Br.unshift([cx(v) + wB(v), v]); }
  const B = [...Bl, ...Br];
  fig.poly(B.map(P), { fill: 0.78 }); fig.pattern("v", B.map(P)); fig.poly(B.map(P), { stroke: 1.6 });
  // 단층선(맨 위에)
  fig.line([P(fault.a), P(fault.b)], { th: 6.5 });
});
fig.poly(frame, { stroke: 2.2 });
// 나무·라벨
for (const u of [0.052, 0.31, 0.445, 0.607, 0.649, 0.834, 0.97]) { fig.line([[X(u), T - 4], [X(u), T - 24]], { th: 1.6 }); fig.dot(X(u), T - 40, 15, 0.35); }
fig.text(X(0.2), Y(0.12), "f", { size: 62, italic: true, anchor: "c" });
fig.text(X(0.9), Y(1.09), "f′", { size: 62, italic: true, anchor: "c" });
fig.text(X(0.33), Y(0.68), "A", { size: 64, anchor: "c" });
fig.circle(X(0.6), Y(0.56), 42, { fill: 1 }); fig.text(X(0.6), Y(0.56) + 22, "B", { size: 64, anchor: "c" });
