// 20번형 지질 단면 — 수평 지층 + 부정합 + 단층(오른쪽 블록 융기 90) + 관입암 A(+) + 암맥 B(v).
// 좌표는 원본 크롭(864×683) 기준 픽셀로 적고 P() 가 W=1000 으로 환산한다.
const S = 1000 / 828, T = 70;
fig.size(1000, 533 * S + T + 120);
const P = ([x, y]) => [(x - 14) * S, T + (y - 56) * S];
const spl = pts => fig.spline(pts);
const surf = spl([[14, 57], [50, 55], [100, 51], [140, 52], [200, 48], [260, 52], [300, 52], [360, 58], [420, 57], [480, 62], [500, 65], [550, 60], [600, 62], [650, 65], [700, 62], [750, 65], [800, 63], [842, 58]]);
const unc = spl([[14, 148], [25, 150], [40, 155], [55, 157], [75, 154], [100, 148], [125, 146], [145, 148], [160, 153], [175, 158], [205, 162], [225, 157], [250, 152], [270, 155], [290, 162], [330, 155], [355, 150], [375, 150], [400, 156], [430, 168], [460, 163], [490, 157], [520, 153], [542, 159], [580, 166], [620, 167], [660, 152], [700, 152], [730, 158], [760, 168], [800, 168], [820, 158], [842, 148]]);
const FA = [180, 160], FB = [750, 588];             // 단층선
const XS = []; for (let x = 14; x <= 842; x += 6) XS.push(x); if (XS[XS.length - 1] !== 842) XS.push(842);
const frame = [[14, 40], [842, 40], [842, 589], [14, 589]].map(P);

fig.clip(frame, () => {
  // 위: 수평 지층(가로줄)
  const hz = [...XS.map(x => P([x, surf(x)])), ...XS.slice().reverse().map(x => P([x, unc(x)]))];
  fig.poly(hz, { fill: 1 });
  fig.clip(hz, () => { for (let k = 0; k < 9; k++) fig.line([P([0, 67 + 10.6 * k]), P([900, 67 + 10.6 * k])], { th: 1.5 }); });
  // 아래: 단층 양쪽 블록(왼쪽 블록 경계 340·454, 오른쪽 블록 250·365·498)
  const sides = [
    { side: 1, b: [340, 454, 640], fills: [0.7, 1, 0.9], pats: [null, "dots", null] },
    { side: -1, b: [250, 365, 498, 640], fills: [0.7, 1, 0.9, 1], pats: [null, "dots", null, "brick"] },
  ];
  for (const { side, b, fills, pats } of sides) {
    let prev = null;
    b.forEach((yb, k) => {
      const topE = XS.map(x => P([x, k === 0 ? unc(x) : Math.max(unc(x), prev)]));
      const botE = XS.slice().reverse().map(x => P([x, Math.max(unc(x), yb)]));
      const poly = fig.clipPoly([...topE, ...botE], P(FA), P(FB), side);
      if (poly.length >= 3) {
        fig.poly(poly, { fill: fills[k] });
        if (pats[k] === "dots") fig.pattern("dots", poly, { sx: 27, r: 2.4 });
        if (pats[k] === "brick") fig.pattern("brick", poly, { hgt: 40.27, wid: 92 });
        if (k < b.length - 1) { const ln = XS.filter(x => unc(x) + 2 < yb).map(x => P([x, yb])); if (ln.length > 1) fig.clip(poly, () => fig.line(ln, { th: 1.7 })); }
      }
      prev = yb;
    });
  }
  fig.line(XS.map(x => P([x, unc(x)])), { th: 1.9 });
  // 관입암 A(+) — 단층에 어긋나 있다
  const A0 = [[186, 589], [190, 560], [197, 510], [203, 470], [208, 440], [215, 410], [225, 380], [238, 355], [250, 332], [262, 312], [278, 292], [308, 257], [240, 205], [250, 190], [262, 180], [280, 170], [300, 165], [330, 155], [352, 150], [375, 150], [395, 157], [420, 167], [435, 172], [455, 195], [478, 222], [500, 250], [540, 300], [537, 432], [578, 458], [588, 480], [596, 520], [604, 555], [612, 572], [626, 589]];
  const A = A0.map(P);
  fig.poly(A, { fill: 1 }); fig.pattern("plus", A, { sx: 54, sy: 48, size: 11.5, th: 2.7, jit: 0.6 }); fig.poly(A, { stroke: 1.8 });
  // 암맥 B(v)
  const B0 = [[542, 159], [530, 200], [520, 230], [500, 250], [497, 270], [480, 300], [450, 350], [430, 380], [400, 430], [390, 470], [375, 530], [350, 565], [340, 589], [487, 589], [497, 550], [505, 530], [510, 500], [520, 475], [530, 450], [537, 430], [550, 410], [575, 365], [590, 325], [600, 300], [625, 250], [645, 190], [662, 152], [620, 167], [580, 166]];
  const B = B0.map(P);
  fig.poly(B, { fill: 0.78 }); fig.pattern("v", B, { sx: 52, sy: 46, size: 8, th: 2, jit: 0.8 }); fig.poly(B, { stroke: 1.8 });
  // 단층선(맨 위에)
  fig.line([P(FA), P(FB)], { th: 7.2 });
});
fig.line([P([14, 57]), P([14, 589]), P([842, 589]), P([842, 58])], { th: 3.2 });
fig.line(XS.map(x => P([x, surf(x)])), { th: 2.6 });
// 나무 — 층층 침엽수
for (const [x, h] of [[44, 44], [272, 44], [382, 34], [516, 28], [550, 40], [704, 34], [818, 44]]) {
  const [px, py] = P([x, surf(x) - 1]);
  const hh = h * S, w = hh * 0.34;
  fig.line([[px, py], [px, py - hh * 0.18]], { th: 2 });
  for (let k = 0; k < 3; k++) {
    const y0 = py - hh * (0.12 + 0.26 * k), y1 = y0 - hh * 0.34, ww = w * (1 - 0.22 * k);
    fig.poly([[px - ww, y0], [px + ww, y0], [px, y1]], { fill: 0.62 });
  }
}
// 라벨 (흰 후광)
const halo = (x, y, w, h) => fig.rect(...P([x - w / 2, y - h / 2]), w * S, h * S, { fill: 1 });
halo(190, 118, 44, 76); fig.text(...P([190, 135]), "f", { size: 92, italic: true, anchor: "c" });
fig.text(...P([764, 655]), "f′", { size: 86, italic: true, anchor: "c" });
fig.text(...P([330, 424]), "A", { size: 112, anchor: "c" });
halo(513, 346, 60, 70); fig.text(...P([513, 372]), "B", { size: 112, anchor: "c" });
