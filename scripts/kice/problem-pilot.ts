/**
 * 파일럿 — 평가원 문항(지구과학Ⅰ 20번·13번)을 **글꼴 + 벡터**로 조판한다(사진 없음).
 * 실행: OUT=결과.pdf npx tsx scripts/kice/problem-pilot.ts
 * 글꼴은 저장소에 있는 나눔명조(해설용 서브셋)로 시험한다 — 실제 평가원 글꼴((한)신중명조 등)은 로그인 버킷에 있다.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import { texToMath } from "../../src/lib/kice/solutionMath";

const BLACK = rgb(0, 0, 0);
type Piece =
  | { t: "text"; s: string }
  | { t: "math"; tex: string }
  | { t: "frac"; top: string; bot: string }
  | { t: "circ"; s: string };
type Unit = Piece[]; // 한 어절(띄어쓰기 없이 붙은 조각들)

const S = 9.6; // 본문 글자 크기(pt)
const PITCH = 15.2; // 줄 간격

export async function build() {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync("public/fonts/solution-serif.ttf"), { subset: false });
  const digits = await pdf.embedFont(fs.readFileSync("public/fonts/number-digits.ttf"), { subset: false });

  const W = (t: string, size = S) => {
    let w = 0;
    for (const c of t) {
      try { w += font.widthOfTextAtSize(c, size); } catch { w += size * 0.5; }
    }
    return w;
  };
  const text = (page: PDFPage, s: string, x: number, y: number, size = S, bold = false, f: PDFFont = font) => {
    if (!s) return;
    for (const dx of bold ? [0, 0.35] : [0]) page.drawText(s, { x: x + dx, y, size, font: f, color: BLACK });
  };
  const hline = (page: PDFPage, x1: number, y1: number, x2: number, y2: number, th = 0.6, dash?: number[]) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: BLACK, ...(dash ? { dashArray: dash } : {}) });

  // ---- 한 조각의 폭/그리기 ----
  const circDigit = new Set("①②③④⑤");
  const pieceW = (p: Piece): number => {
    if (p.t === "text") return W(p.s);
    if (p.t === "math") { const b = texToMath(p.tex); return b ? b.w * S : W(p.tex); }
    if (p.t === "frac") return Math.max(W(p.top), W(p.bot)) + 3;
    return S * 1.05;
  };
  const drawPiece = (page: PDFPage, p: Piece, x: number, base: number) => {
    if (p.t === "text") text(page, p.s, x, base);
    else if (p.t === "math") {
      const b = texToMath(p.tex);
      if (b) page.drawSvgPath(b.d, { x, y: base, scale: S, color: BLACK, borderWidth: 0 });
      else text(page, p.tex, x, base);
    } else if (p.t === "frac") {
      const w = pieceW(p);
      const tw = W(p.top);
      const bw = W(p.bot);
      text(page, p.top, x + (w - tw) / 2, base + S * 0.95);
      text(page, p.bot, x + (w - bw) / 2, base - S * 0.78);
      hline(page, x, base + S * 0.32, x + w, base + S * 0.32, 0.5);
    } else {
      // 원문자: ㉠ ㉡ 은 글꼴 글리프, ①~⑤ 는 동그라미 + 숫자를 직접 그린다.
      if (circDigit.has(p.s)) {
        const d = S * 0.98;
        page.drawCircle({ x: x + d / 2 + 0.2, y: base + S * 0.33, size: d / 2, borderWidth: 0.55, borderColor: BLACK });
        const n = String("①②③④⑤".indexOf(p.s) + 1);
        text(page, n, x + d / 2 + 0.2 - digits.widthOfTextAtSize(n, S * 0.72) / 2, base + S * 0.33 - S * 0.25, S * 0.72, false, digits);
      } else text(page, p.s, x, base, S * 1.05);
    }
  };

  // ---- 문단: 어절 단위 줄바꿈 + 양쪽 맞춤 ----
  const GAP = S * 0.3; // 어절 사이 기본 간격
  const unitW = (u: Unit) => u.reduce((a, p) => a + pieceW(p), 0);
  /** 한 문단을 그린다. `first`=첫 줄 들여쓰기, `hang`=둘째 줄부터 들여쓰기. 새 y(아래쪽 끝)를 돌려준다. */
  function paragraph(page: PDFPage, units: Unit[], x: number, top: number, width: number, opt: { first?: number; hang?: number; justify?: boolean } = {}) {
    const first = opt.first ?? 0;
    const hang = opt.hang ?? 0;
    const lines: { units: Unit[]; indent: number; last: boolean }[] = [];
    let cur: Unit[] = [];
    let used = 0;
    let indent = first;
    for (const u of units) {
      const w = unitW(u);
      const need = (cur.length ? GAP : 0) + w;
      if (cur.length && indent + used + need > width) {
        lines.push({ units: cur, indent, last: false });
        cur = [];
        used = 0;
        indent = hang;
      }
      used += (cur.length ? GAP : 0) + w;
      cur.push(u);
    }
    if (cur.length) lines.push({ units: cur, indent, last: true });
    let y = top;
    for (const ln of lines) {
      const hasFrac = ln.units.some((u) => u.some((p) => p.t === "frac"));
      if (hasFrac) y += S * 0.55;
      const base = y + S * 1.05;
      const natural = ln.units.reduce((a, u) => a + unitW(u), 0) + GAP * (ln.units.length - 1);
      const avail = width - ln.indent;
      const justify = (opt.justify ?? true) && !ln.last && ln.units.length > 1;
      const gap = justify ? GAP + (avail - natural) / (ln.units.length - 1) : GAP;
      let cx = x + ln.indent;
      for (const u of ln.units) {
        for (const p of u) {
          drawPiece(page, p, cx, page.getHeight() - base);
          cx += pieceW(p);
        }
        cx += gap;
      }
      y += PITCH + (hasFrac ? S * 0.55 : 0);
    }
    return y;
  }
  const toUnits = (src: (string | Piece)[]): Unit[] => {
    // 문자열은 공백으로 어절을 나누고, Piece 는 앞뒤 어절에 붙인다(공백 문자 "_" 로 구분하려면 " " 를 직접 넣는다).
    const units: Unit[] = [];
    let cur: Unit = [];
    const push = () => { if (cur.length) { units.push(cur); cur = []; } };
    for (const item of src) {
      if (typeof item !== "string") { cur.push(item); continue; }
      const parts = item.split(/( )/);
      for (const part of parts) {
        if (part === " ") push();
        else if (part) cur.push({ t: "text", s: part });
      }
    }
    push();
    return units;
  };

  const PAGE_W = 380;
  const PAGE_H = 560;
  const X0 = 26;
  const TW = 327;

  // 좌표 변환용: 위에서 아래로 재는 y 를 pdf y 로.
  const fy = (page: PDFPage, y: number) => page.getHeight() - y;

  // ================= 20번 =================
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    let y = 30;
    // 번호
    text(page, "20.", X0, fy(page, y + 12), 15, true, digits);
    const NX = X0 + 28;
    y = paragraph(
      page,
      toUnits([
        "그림은 어느 지역의 지질 단면을, 표는 방사성 원소 ", { t: "text", s: "Y" }, "의 함량(%)에 대한 방사성 원소 X의 함량(%)과 Y의 함량(%)에 대한 Y의 자원소 함량(%)을 시기별로 나타낸 것이다. 화성암 A는 X와 Y를 모두 포함하며, 현재 A에 포함된 X의 함량은 처음 양의 26%이다. 화성암 B의 절대 연령은 1억 년이다.",
      ]),
      NX, y - 2, TW - 28, { first: 0, hang: 0 },
    );
    // 번호 줄 이후 문단은 번호 너비만큼 들여쓰기한 채로 흐른다 — 위 문단에서 이미 NX 기준.
    y += 10;
    const figTop = y;
    const figW = 150;
    const figH = 105;
    drawGeoSection(page, X0 + 2, figTop, figW, figH);
    // 표
    const tx = X0 + figW + 14;
    const tw = TW - figW - 14 + 6;
    const colA = tw * 0.56;
    const colB = (tw - colA) / 2;
    const r1 = 22;
    const r2 = 38;
    const ty = figTop + 2;
    const tb = ty + r1 + r2 * 2;
    page.drawRectangle({ x: tx, y: fy(page, tb), width: tw, height: tb - ty, borderColor: BLACK, borderWidth: 0.7 });
    hline(page, tx, fy(page, ty + r1), tx + tw, fy(page, ty + r1), 0.7);
    hline(page, tx, fy(page, ty + r1 + r2), tx + tw, fy(page, ty + r1 + r2), 0.7);
    hline(page, tx + colA, fy(page, ty), tx + colA, fy(page, tb), 0.7);
    hline(page, tx + colA + colB, fy(page, ty), tx + colA + colB, fy(page, tb), 0.7);
    const sz = 7.2;
    const cen = (s: string, cx: number, base: number, size = sz) => text(page, s, cx - W(s, size) / 2, base, size);
    cen("암석 생성 이후 경과 시간", tx + colA / 2, fy(page, ty + r1 / 2 + 3));
    cen("2억 년", tx + colA + colB / 2, fy(page, ty + r1 / 2 + 3));
    cen("3억 년", tx + colA + colB * 1.5, fy(page, ty + r1 / 2 + 3));
    const fracCell = (top: string, bot: string, cx: number, mid: number, w: number) => {
      cen(top, cx, fy(page, mid - 3));
      cen(bot, cx, fy(page, mid + 9.5));
      hline(page, cx - w / 2, fy(page, mid), cx + w / 2, fy(page, mid), 0.5);
    };
    fracCell("X의 함량(%)", "Y의 함량(%)", tx + colA / 2, ty + r1 + r2 / 2, W("X의 함량(%)", sz) + 6);
    fracCell("Y의 자원소 함량(%)", "Y의 함량(%)", tx + colA / 2, ty + r1 + r2 + r2 / 2, W("Y의 자원소 함량(%)", sz) + 6);
    // 1/2, 1
    const midX = tx + colA + colB / 2;
    cen("1", midX, fy(page, ty + r1 + r2 / 2 - 3), 8.6);
    cen("2", midX, fy(page, ty + r1 + r2 / 2 + 9.5), 8.6);
    hline(page, midX - 5, fy(page, ty + r1 + r2 / 2), midX + 5, fy(page, ty + r1 + r2 / 2), 0.5);
    cen("1", midX, fy(page, ty + r1 + r2 + r2 / 2 + 3), 8.6);
    const c3 = tx + colA + colB * 1.5;
    cen("( ㉠ )", c3, fy(page, ty + r1 + r2 / 2 + 3), 8.6);
    cen("( ㉡ )", c3, fy(page, ty + r1 + r2 + r2 / 2 + 3), 8.6);

    y = Math.max(figTop + figH, tb) + 14;
    y = paragraph(
      page,
      toUnits(["이 자료에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? (단, X의 자원소는 X가, Y의 자원소는 Y가 붕괴하여 생성되었으며, 자원소 함량(%)은 붕괴한 방사성 원소 함량과 같다. 방사성 원소의 함량(%)은 처음 양에 대한 남아 있는 양의 비율이다.) [3점]"]),
      X0, y, TW, { first: S * 1.0, hang: 0 },
    );
    y += 12;
    // 보기 상자
    const boxTop = y + 6;
    const items: { label: string; units: Unit[] }[] = [
      { label: "ㄱ.", units: toUnits(["단층 ", { t: "math", tex: "f\\!-\\!f'" }, "은 고생대에 형성되었다."]) },
      { label: "ㄴ.", units: toUnits([{ t: "circ", s: "㉡" }, "은 ", { t: "circ", s: "㉠" }, "의 5배보다 크다."]) },
      {
        label: "ㄷ.",
        units: toUnits([
          "현재로부터 Y의 반감기가 1회 지났을 때, A에 포함된 ",
          { t: "frac", top: "X의 자원소 함량(%)", bot: "Y의 자원소 함량(%)" },
          "은 1.2보다 작다.",
        ]),
      },
    ];
    let by = boxTop + 11;
    for (const it of items) {
      text(page, it.label, X0 + 12, fy(page, by + S * 1.05), S);
      by = paragraph(page, it.units, X0 + 12 + 22, by, TW - 24 - 22, { first: 0, hang: 0 });
    }
    const boxBot = by + 4;
    const boxL = X0;
    const boxR = X0 + TW;
    const title = "<보 기>";
    const tW = W(title, S * 1.05) + 6;
    const cx = (boxL + boxR) / 2;
    hline(page, boxL, fy(page, boxTop), cx - tW / 2, fy(page, boxTop), 0.7);
    hline(page, cx + tW / 2, fy(page, boxTop), boxR, fy(page, boxTop), 0.7);
    hline(page, boxL, fy(page, boxTop), boxL, fy(page, boxBot), 0.7);
    hline(page, boxR, fy(page, boxTop), boxR, fy(page, boxBot), 0.7);
    hline(page, boxL, fy(page, boxBot), boxR, fy(page, boxBot), 0.7);
    text(page, title, cx - tW / 2 + 3, fy(page, boxTop + 3.2), S * 1.05);
    // 선지
    const ch = ["ㄱ", "ㄴ", "ㄷ", "ㄱ, ㄴ", "ㄴ, ㄷ"];
    const cy = boxBot + 24;
    const xs = [X0, X0 + 64, X0 + 129, X0 + 194, X0 + 259];
    ch.forEach((c, i) => {
      drawPiece(page, { t: "circ", s: "①②③④⑤"[i] }, xs[i], fy(page, cy));
      text(page, c, xs[i] + S * 1.5, fy(page, cy), S);
    });
  }

  // ================= 13번 =================
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    let y = 30;
    text(page, "13.", X0, fy(page, y + 12), 15, true, digits);
    const NX = X0 + 28;
    y = paragraph(
      page,
      toUnits(["그림은 A와 B 시기에 지표로부터 1.5km 부근에서 대기 대순환에 의해 부는 바람의 남북 방향의 평균 풍속을 나타낸 것이다."]),
      NX, y - 2, TW - 28, { first: 0, hang: 0 },
    );
    y += 14;
    drawWindPanels(page, X0, y, TW);
    y += 128;
    y = paragraph(
      page,
      toUnits(["이 자료에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? [3점]"]),
      X0, y, TW, { first: S * 1.0, hang: 0 },
    );
    y += 12;
    const boxTop = y + 6;
    const items: { label: string; units: Unit[] }[] = [
      { label: "ㄱ.", units: toUnits([{ t: "circ", s: "㉠" }, "의 지표 부근에서는 대기 대순환에 의한 공기의 발산이 나타난다."]) },
      { label: "ㄴ.", units: toUnits([{ t: "circ", s: "㉡" }, "의 해역에서 표층 해류의 아열대 순환은 시계 반대 방향으로 나타난다."]) },
      { label: "ㄷ.", units: toUnits(["지표 부근에서 해들리 순환의 상승 기류는 A가 B보다 저위도에서 나타난다."]) },
    ];
    let by = boxTop + 11;
    for (const it of items) {
      text(page, it.label, X0 + 12, fy(page, by + S * 1.05), S);
      by = paragraph(page, it.units, X0 + 12 + 22, by, TW - 24 - 22, { first: 0, hang: 0 });
    }
    const boxBot = by + 4;
    const boxL = X0;
    const boxR = X0 + TW;
    const title = "<보 기>";
    const tW = W(title, S * 1.05) + 6;
    const cx = (boxL + boxR) / 2;
    hline(page, boxL, fy(page, boxTop), cx - tW / 2, fy(page, boxTop), 0.7);
    hline(page, cx + tW / 2, fy(page, boxTop), boxR, fy(page, boxTop), 0.7);
    hline(page, boxL, fy(page, boxTop), boxL, fy(page, boxBot), 0.7);
    hline(page, boxR, fy(page, boxTop), boxR, fy(page, boxBot), 0.7);
    hline(page, boxL, fy(page, boxBot), boxR, fy(page, boxBot), 0.7);
    text(page, title, cx - tW / 2 + 3, fy(page, boxTop + 3.2), S * 1.05);
    const ch = ["ㄱ", "ㄷ", "ㄱ, ㄴ", "ㄴ, ㄷ", "ㄱ, ㄴ, ㄷ"];
    const cy = boxBot + 24;
    const xs = [X0, X0 + 64, X0 + 129, X0 + 194, X0 + 259];
    ch.forEach((c, i) => {
      drawPiece(page, { t: "circ", s: "①②③④⑤"[i] }, xs[i], fy(page, cy));
      text(page, c, xs[i] + S * 1.5, fy(page, cy), S);
    });
  }

  // ----------- 도식 20: 지질 단면 -----------
  function drawGeoSection(page: PDFPage, ox: number, oy: number, w: number, h: number) {
    // 원본 그림 좌표(470×330, 왼쪽 위가 원점)를 w×h 로 줄인다.
    const sx = w / 470;
    const sy = h / 330;
    const P = (x: number, y: number): [number, number] => [ox + x * sx, fy(page, oy + y * sy)];
    const poly = (pts: [number, number][], fill?: [number, number, number], stroke = 0.4) => {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join("") + "Z";
      page.drawSvgPath(d, { x: ox, y: fy(page, oy), scale: 1, ...(fill ? { color: rgb(...fill) } : { color: rgb(1, 1, 1), opacity: 0 }), borderColor: BLACK, borderWidth: stroke });
    };
    // 도식 좌표는 sx,sy 로 직접 변환한 값을 넘기므로 단위를 맞추려 래퍼를 쓴다.
    const poly2 = (pts: [number, number][], fill?: [number, number, number], stroke = 0.4) =>
      poly(pts.map(([x, y]) => [x * sx, y * sy] as [number, number]), fill, stroke);
    const GR1: [number, number, number] = [0.64, 0.64, 0.64];
    const GR2: [number, number, number] = [0.85, 0.85, 0.85];
    const GR3: [number, number, number] = [0.74, 0.74, 0.74];
    // 바깥 틀 + 위 지층(가로줄)
    poly2([[0, 30], [470, 30], [470, 330], [0, 330]], [1, 1, 1], 0.7);
    for (let yy = 32; yy < 84; yy += 8) hline(page, ...P(0, yy), ...P(470, yy), 0.35);
    // 부정합면(물결)
    const wave = (yy: number) => `M${0} ${yy * sy}` + Array.from({ length: 24 }, (_, i) => `L${(i + 1) * 20 * sx} ${(yy + (i % 2 ? -5 : 3) * (i % 3 ? 1 : 0.4)) * sy}`).join("");
    page.drawSvgPath(wave(84), { x: ox, y: fy(page, oy), scale: 1, color: rgb(1, 1, 1), opacity: 0, borderColor: BLACK, borderWidth: 0.6 });
    // 왼쪽 지층(A 의 왼쪽 경계까지)
    poly2([[0, 86], [140, 86], [133, 192], [0, 192]], GR1);
    poly2([[0, 192], [133, 192], [118, 255], [0, 255]], GR2);
    poly2([[0, 255], [118, 255], [105, 330], [0, 330]], [0.9, 0.9, 0.9]);
    // 오른쪽 지층(B 의 오른쪽 경계부터)
    poly2([[356, 86], [470, 86], [470, 140], [340, 140]], GR1);
    poly2([[340, 140], [470, 140], [470, 200], [323, 200]], GR2);
    poly2([[323, 200], [470, 200], [470, 280], [301, 280]], [0.9, 0.9, 0.9]);
    poly2([[360, 280], [470, 280], [470, 330], [360, 330]], [1, 1, 1]);
    for (let yy = 292; yy < 330; yy += 12) hline(page, ...P(360, yy), ...P(470, yy), 0.35);
    for (let xx = 372; xx < 470; xx += 24) hline(page, ...P(xx, 280), ...P(xx, 330), 0.3);
    // 화성암 A(+) — 아래로 갈수록 넓다
    poly2([[140, 88], [292, 88], [190, 330], [105, 330]], [1, 1, 1]);
    poly2([[301, 250], [338, 330], [272, 330]], [1, 1, 1]);
    // 화성암 B(v) — 대각선 암맥
    poly2([[292, 86], [358, 86], [275, 330], [190, 330]], [0.78, 0.78, 0.78]);
    // 단층 f-f′
    hline(page, ...P(95, 84), ...P(420, 330), 2.2);
    text(page, "f", ox + 90 * sx, fy(page, oy + 76 * sy + 0), 8, false);
    text(page, "f′", ox + 420 * sx, fy(page, oy + 345 * sy), 8);
    text(page, "A", ox + 165 * sx, fy(page, oy + 215 * sy), 10);
    text(page, "B", ox + 305 * sx, fy(page, oy + 200 * sy), 10);
    // 나무
    for (const tx of [10, 150, 268, 300, 330, 450]) {
      hline(page, ...P(tx, 32), ...P(tx, 22), 0.4);
      page.drawEllipse({ x: P(tx, 17)[0], y: P(tx, 20)[1], xScale: 1.6, yScale: 2.6, color: rgb(0.2, 0.2, 0.2) });
    }
    // + 와 v 무늬
    const plus = (cx: number, cy: number) => {
      const [x, y] = P(cx, cy);
      hline(page, x - 1.4, y, x + 1.4, y, 0.3);
      hline(page, x, y - 1.4, x, y + 1.4, 0.3);
    };
    for (let yy = 112; yy < 330; yy += 22) for (let xx = 232; xx < 330; xx += 28) if (xx > 225 + (yy - 112) * 0.0 && xx < 380 - (yy < 160 ? 50 : 0)) plus(xx - (yy > 250 ? 10 : 0), yy);
    for (let yy = 100; yy < 330; yy += 24) {
      const bx = 410 - (yy - 86) * (110 / 244);
      for (const dx of [-20, 5, 28]) {
        const [x, y] = P(bx + dx, yy);
        hline(page, x - 1.3, y + 0.8, x, y - 0.8, 0.3);
        hline(page, x, y - 0.8, x + 1.3, y + 0.8, 0.3);
      }
    }
    // 점무늬(사암)
    for (let yy = 196; yy < 255; yy += 10) for (let xx = 8; xx < 150; xx += 13) { const [x, y] = P(xx + (yy % 20), yy); page.drawCircle({ x, y, size: 0.35, color: BLACK }); }
    for (let yy = 148; yy < 198; yy += 10) for (let xx = 310; xx < 470; xx += 13) { const [x, y] = P(xx + (yy % 20), yy); page.drawCircle({ x, y, size: 0.35, color: BLACK }); }
  }

  // ----------- 도식 13: 바람 단면 두 개 -----------
  function drawWindPanels(page: PDFPage, ox: number, oy: number, tw: number) {
    const pw = (tw - 22) / 2;
    const ph = 62;
    const panels = [
      { x: ox + 14, label: "A (북반구 겨울철)", shade: [0.34, 0.37] as [number, number] },
      { x: ox + 14 + pw + 8, label: "B (북반구 여름철)", shade: [0.57, 0.86] as [number, number] },
    ];
    // 범례 상자
    const lw = 100;
    const lx = ox + tw / 2 - lw / 2;
    page.drawRectangle({ x: lx, y: fy(page, oy + 8 + 10), width: lw, height: 14, borderColor: BLACK, borderWidth: 0.6 });
    hline(page, lx + 4, fy(page, oy + 11), lx + 16, fy(page, oy + 11), 0.6);
    text(page, ": 남풍", lx + 18, fy(page, oy + 13.5), 6.2);
    hline(page, lx + 50, fy(page, oy + 11), lx + 62, fy(page, oy + 11), 0.5, [1.5, 1]);
    text(page, ": 북풍", lx + 64, fy(page, oy + 13.5), 6.2);
    panels.forEach((p, idx) => {
      const top = oy + 22;
      // 음영
      page.drawRectangle({ x: p.x + p.shade[0] * pw, y: fy(page, top + ph), width: (p.shade[1] - p.shade[0]) * pw, height: ph, color: rgb(0.8, 0.8, 0.8) });
      page.drawRectangle({ x: p.x, y: fy(page, top + ph), width: pw, height: ph, borderColor: BLACK, borderWidth: 0.7 });
      const X = (u: number) => p.x + u * pw;
      const Y = (v: number) => fy(page, top + v * ph);
      const curve = (pts: [number, number][], th = 0.5, dash?: number[], closed = false) => {
        // 부드러운 곡선(Catmull-Rom → 베지어)
        const P2 = pts.map(([u, v]) => [X(u), top + v * ph] as [number, number]);
        let d = `M${P2[0][0]} ${P2[0][1]}`;
        const n = P2.length;
        const g = (i: number) => P2[((i % n) + n) % n];
        for (let i = 0; i < (closed ? n : n - 1); i++) {
          const a = closed ? g(i - 1) : P2[Math.max(0, i - 1)];
          const b = P2[i % n];
          const c = closed ? g(i + 1) : P2[i + 1];
          const dd = closed ? g(i + 2) : P2[Math.min(n - 1, i + 2)];
          d += `C${b[0] + (c[0] - a[0]) / 6} ${b[1] + (c[1] - a[1]) / 6} ${c[0] - (dd[0] - b[0]) / 6} ${c[1] - (dd[1] - b[1]) / 6} ${c[0]} ${c[1]}`;
        }
        page.drawSvgPath(d, { x: 0, y: page.getHeight(), scale: 1, color: rgb(1, 1, 1), opacity: 0, borderColor: BLACK, borderWidth: th, ...(dash ? { borderDashArray: dash } : {}) });
      };
      // y 좌표를 svg 로 넘기므로(위가 0) 도식 로컬 변환: Y() 는 pdf 좌표라 아래 보조로 변환한다.
      const ellipseSet = (cu: number, cv: number, ru: number, rv: number, n: number, dash?: number[], th = 0.45) => {
        for (let k = 1; k <= n; k++) {
          const f = k / n;
          const pts: [number, number][] = Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2;
            return [cu + Math.cos(a) * ru * f * (1 + 0.08 * Math.sin(3 * a)), cv + Math.sin(a) * rv * f] as [number, number];
          });
          curve(pts, th, dash, true);
        }
      };
      const zero = (pts: [number, number][]) => curve(pts, 1.6);
      page.pushOperators(pushGraphicsState(), moveTo(p.x, fy(page, top)), lineTo(p.x + pw, fy(page, top)), lineTo(p.x + pw, fy(page, top + ph)), lineTo(p.x, fy(page, top + ph)), closePath(), clip(), endPath());
      if (idx === 0) {
        zero([[0.08, 1], [0.1, 0.65], [0.06, 0.42]]);
        zero([[0.16, 1], [0.17, 0.5], [0.15, 0.2]]);
        zero([[0.24, 1], [0.25, 0.4], [0.24, 0.1]]);
        ellipseSet(0.14, 1.0, 0.05, 0.3, 2, undefined);
        ellipseSet(0.31, 1.05, 0.08, 0.45, 2, undefined);
        curve([[0.35, 0.6], [0.36, 0.3], [0.34, 0.15]], 0.5);
        zero([[0.38, 1], [0.37, 0.4], [0.355, 0]]);
        ellipseSet(0.43, 0.8, 0.07, 0.55, 5, [1.6, 1.1]);
        ellipseSet(0.52, 1.0, 0.04, 0.35, 3, [1.6, 1.1]);
        zero([[0.43, 1], [0.46, 0.55], [0.48, 0.1], [0.5, 0]]);
        zero([[0.6, 1], [0.58, 0.55], [0.64, 0.3], [0.66, 0]]);
        ellipseSet(0.64, 1.0, 0.1, 0.55, 3, undefined);
        ellipseSet(0.79, 0.85, 0.08, 0.5, 4, [1.6, 1.1]);
        zero([[0.76, 1], [0.8, 0.5], [0.77, 0]]);
        zero([[0.9, 1], [0.86, 0.5], [0.9, 0]]);
        for (let k = 0; k < 10; k++) curve([[0.89 + k * 0.01, 1], [0.9 + k * 0.01, 0.2], [0.91 + k * 0.01, 0]], 0.35);
      } else {
        zero([[0.08, 1], [0.1, 0.5], [0.05, 0.3]]);
        zero([[0.2, 1], [0.21, 0.5], [0.19, 0.15]]);
        zero([[0.3, 1], [0.32, 0.4], [0.3, 0]]);
        ellipseSet(0.44, 0.85, 0.25, 0.9, 6, undefined);
        ellipseSet(0.5, 1.0, 0.12, 0.4, 3, undefined);
        zero([[0.5, 1], [0.52, 0.5], [0.55, 0]]);
        ellipseSet(0.66, 0.95, 0.12, 0.45, 3, [1.6, 1.1]);
        zero([[0.88, 1], [0.84, 0.6], [0.9, 0.3], [0.88, 0]]);
        for (let k = 0; k < 10; k++) curve([[0.9 + k * 0.01, 1], [0.91 + k * 0.01, 0.4], [0.9 + k * 0.01, 0]], 0.35);
      }
      page.pushOperators(popGraphicsState());
      // 영(0) 표시: 흰 바탕 숫자
      const zl = idx === 0 ? [[0.07, 0.42], [0.17, 0.42], [0.25, 0.3], [0.5, 0.2], [0.6, 0.35], [0.8, 0.3], [0.9, 0.1]] : [[0.1, 0.4], [0.21, 0.35], [0.32, 0.3], [0.52, 0.25], [0.7, 0.3], [0.9, 0.2]];
      zl.forEach(([u, v]) => {
        page.drawRectangle({ x: X(u) - 2, y: Y(v) - 2.5, width: 5, height: 7, color: rgb(1, 1, 1) });
        text(page, "0", X(u) - 2, Y(v) - 1.5, 6);
      });
      // 단위 상자
      page.drawRectangle({ x: p.x + 1, y: Y(0.28), width: 30, height: 8.5, color: rgb(1, 1, 1), borderColor: BLACK, borderWidth: 0.4 });
      text(page, "단위: m/s", p.x + 3, Y(0.28) + 2.3, 5.6);
      // 눈금 라벨
      text(page, "90°", p.x - 5, fy(page, top + ph + 8), 6);
      text(page, "0°", p.x + pw / 2 - 3, fy(page, top + ph + 8), 6);
      text(page, "90°", p.x + pw - 6, fy(page, top + ph + 8), 6);
      text(page, "0", p.x - 6, fy(page, top + ph - 1), 6);
      text(page, "위도", p.x + pw / 2 - 5, fy(page, top + ph + 16), 6.4);
      text(page, p.label, p.x + pw / 2 - W(p.label, 7.6) / 2, fy(page, top + ph + 27), 7.6);
      // 높이 축
      text(page, "↑", p.x - 8, Y(0.35), 6.5);
      text(page, "높", p.x - 9, Y(0.5), 5.6);
      text(page, "이", p.x - 9, Y(0.65), 5.6);
      // ㉠ ㉡ 표시
      const sh = p.shade;
      const lab = idx === 0 ? "㉠" : "㉡";
      const cxl = X((sh[0] + sh[1]) / 2);
      text(page, lab, cxl - 4, fy(page, top - 9), 8.5);
      if (idx === 0) {
        hline(page, X(sh[0]), fy(page, top - 3), X(sh[1]), fy(page, top - 3), 0.5);
      } else {
        hline(page, X(sh[0]), fy(page, top - 3), X(sh[1]), fy(page, top - 3), 0.5);
        hline(page, X(sh[0]), fy(page, top - 5), X(sh[0]), fy(page, top - 1), 0.5);
        hline(page, X(sh[1]), fy(page, top - 5), X(sh[1]), fy(page, top - 1), 0.5);
      }
    });
  }

  return pdf.save();
}

build().then((b) => {
  fs.writeFileSync(process.env.OUT ?? "pilot.pdf", b);
  console.log("ok", b.length);
});
