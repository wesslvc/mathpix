// 13번형 등속선 단면 두 패널 — 영(0)선 곡선(스플라인)과 구간 프로필 함수로 장을 계산한다.
fig.size(2080, 640);
const PW = 940, PH = 380;                 // 패널 안쪽 크기
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function panel(ox, oy, P) {
  const X = u => ox + 60 + u * PW, Y = v => oy + 70 + (1 - v) * PH;
  // 경계 스플라인: 각 곡선 [[v,u],...] (v 오름차순)
  const Z = P.zero.map(c => fig.spline(c));
  const E0 = () => 0, E1 = () => 1;
  const bounds = [E0, ...Z, E1];
  const field = (u, v) => {
    let val = 0;
    for (let k = 0; k < P.regions.length; k++) {
      const R = P.regions[k], L = bounds[k](v), Rr = bounds[k + 1](v);
      if (u <= L || u >= Rr) continue;
      const w = Rr - L, t = (u - L) / w;
      const pk = R.peak ?? 0.5;
      const shape = t < pk ? t / pk : (1 - t) / (1 - pk);
      const prof = Math.pow(Math.sin(Math.PI / 2 * shape), R.q ?? 0.9) * Math.min(1, w / (R.wref ?? 0.2));
      const vert = 0.03 + 0.97 * Math.pow(clamp(1 - v / (R.vtop ?? 1.2), 0, 1), R.r ?? 0.6);
      val += R.a * prof * vert;
    }
    return val;
  };
  // 음영
  for (const s of P.shades ?? []) fig.rect(X(s.u0), Y(1), (s.u1 - s.u0) * PW, PH, { fill: 0.8 });
  const frame = [[X(0), Y(1)], [X(1), Y(1)], [X(1), Y(0)], [X(0), Y(0)]];
  fig.clip(frame, () => {
    fig.contour(field, { x0: 0, x1: 1, y0: 0, y1: 1, levels: P.levels, nx: 420, ny: 170, map: (u, v) => [X(u), Y(v)], thZero: 5.4, thin: 1.7 });
    for (const [u, v] of P.zeroLabels) { fig.rect(X(u) - 14, Y(v) - 26, 28, 44, { fill: 1 }); fig.text(X(u), Y(v) + 12, "0", { size: 30, anchor: "c" }); }
    for (const l of P.valueLabels ?? []) { fig.rect(X(l.u) - 14, Y(l.v) - 26, 28, 44, { fill: 1 }); fig.text(X(l.u), Y(l.v) + 12, l.text, { size: 30, anchor: "c" }); }
  });
  fig.poly(frame, { stroke: 2.2 });
  // 단위 상자·눈금·제목
  fig.rect(X(0), Y(1), 232, 54, { fill: 1, stroke: 1.8 });
  fig.text(X(0) + 12, Y(1) + 39, "단위: m/s", { size: 32 });
  for (const [u, s] of [[0, "90°"], [0.5, "0°"], [1, "90°"]]) fig.text(X(u), Y(0) + 40, s, { size: 30, anchor: "c" });
  fig.text(X(0) - 14, Y(0) + 8, "0", { size: 30, anchor: "r" });
  fig.text(X(0.5), Y(0) + 80, "위도", { size: 30, anchor: "c" });
  fig.text(X(0) - 36, Y(0.5) + 20, "높이", { size: 28, anchor: "c", vertical: true });
  fig.text(X(0) - 36, Y(0.8), "↑", { size: 28, anchor: "c" });
  fig.text(X(0.5), Y(0) + 128, P.title, { size: 34, anchor: "c" });
  for (const s of P.shades ?? []) {
    const cx = (X(s.u0) + X(s.u1)) / 2, y = Y(1) - 14;
    fig.circled(cx, Y(1) - 48, s.ch, 38);
    fig.line([[X(s.u0), y], [X(s.u1), y]], { th: 1.8 });
    if (s.style === "arrow") {
      fig.poly([[X(s.u0), y], [X(s.u0) + 12, y - 6], [X(s.u0) + 12, y + 6]], { fill: 0 });
      fig.poly([[X(s.u1), y], [X(s.u1) - 12, y - 6], [X(s.u1) - 12, y + 6]], { fill: 0 });
    } else { fig.line([[X(s.u0), y - 10], [X(s.u0), y + 10]], { th: 1.8 }); fig.line([[X(s.u1), y - 10], [X(s.u1), y + 10]], { th: 1.8 }); }
  }
}

// 범례
fig.rect(840, 0, 400, 56, { fill: 1, stroke: 1.8 });
fig.line([[866, 28], [930, 28]], { th: 2.4 }); fig.text(944, 40, ": 남풍", { size: 30 });
fig.line([[1040, 28], [1104, 28]], { th: 1.8, dash: [7, 5] }); fig.text(1118, 40, ": 북풍", { size: 30 });

// ---- 패널 A ---- (영선: [v,u] 점들)
panel(0, 70, {
  title: "A (북반구 겨울철)", levels: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4],
  shades: [{ u0: 0.31, u1: 0.37, ch: "㉠", style: "arrow" }],
  zero: [
    [[0, 0.0], [0.3, 0.0], [0.32, 0.014], [0.4, 0.034], [0.62, 0.045], [1, 0.045]],
    [[0, 0.085], [0.4, 0.098], [1, 0.1]],
    [[0, 0.168], [0.5, 0.177], [1, 0.18]],
    [[0, 0.323], [0.5, 0.355], [1, 0.365]],
    [[0, 0.523], [0.3, 0.545], [0.46, 0.585], [0.65, 0.62], [0.9, 0.628], [1, 0.64]],
    [[0, 0.695], [0.5, 0.693], [1, 0.69]],
    [[0, 0.855], [0.3, 0.85], [0.53, 0.84], [0.58, 0.8], [0.66, 0.773], [1, 0.764]],
    [[0, 0.945], [0.6, 0.945], [1, 0.94]],
  ],
  regions: [
    { a: -0.5 }, { a: 0.5 }, { a: -0.5 },
    { a: 1.9, vtop: 1.0, q: 0.9, r: 0.6, peak: 0.35, wref: 0.15 },
    { a: -6.2, vtop: 1.25, q: 0.85, r: 0.55, peak: 0.45, wref: 0.2 },
    { a: 3.4, vtop: 0.75, q: 0.7, r: 0.8, peak: 0.55, wref: 0.07 },
    { a: -3.6, vtop: 0.62, q: 0.85, r: 0.8, peak: 0.62, wref: 0.1 },
    { a: 3.0, vtop: 2.0, q: 0.5, r: 0.25, peak: 0.5, wref: 0.05 },
    { a: -0.5 },
  ],
  zeroLabels: [[0.04, 0.55], [0.1, 0.35], [0.18, 0.55], [0.355, 0.78], [0.56, 0.52], [0.69, 0.52], [0.78, 0.78], [0.955, 0.85], [0.115, 0.1]],
});

// ---- 패널 B ----
panel(1040, 70, {
  title: "B (북반구 여름철)", levels: [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8],
  shades: [{ u0: 0.58, u1: 0.83, ch: "㉡", style: "bracket" }],
  valueLabels: [{ u: 0.49, v: 0.32, text: "2" }],
  zero: [
    [[0, 0.0], [0.32, 0.0], [0.34, 0.009], [0.42, 0.036], [0.61, 0.044], [0.75, 0.045], [1, 0.045]],
    [[0, 0.09], [0.5, 0.098], [1, 0.1]],
    [[0, 0.136], [0.5, 0.137], [1, 0.137]],
    [[0, 0.3], [0.35, 0.29], [0.7, 0.28], [1, 0.278]],
    [[0, 0.4], [0.5, 0.397], [1, 0.395]],
    [[0, 0.636], [0.3, 0.627], [0.7, 0.618], [1, 0.614]],
    [[0, 0.84], [0.4, 0.835], [0.7, 0.83], [1, 0.826]],
  ],
  regions: [
    { a: -0.5 }, { a: 0.5 }, { a: -0.5 }, { a: 0.5 }, { a: -0.6 },
    { a: 9.0, vtop: 1.45, q: 0.8, r: 0.55, peak: 0.32, wref: 0.24 },
    { a: -1.9, vtop: 0.42, q: 0.9, r: 0.9, peak: 0.45, wref: 0.2 },
    { a: 4.5, vtop: 2.0, q: 0.5, r: 0.25, peak: 0.4, wref: 0.16 },
  ],
  zeroLabels: [[0.04, 0.58], [0.095, 0.31], [0.136, 0.58], [0.305, 0.71], [0.395, 0.74], [0.28, 0.52], [0.617, 0.77], [0.755, 0.82], [0.845, 0.65]],
});
