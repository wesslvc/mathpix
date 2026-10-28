/**
 * 파일럿 — 평가원 문항(지구과학Ⅰ 20번·13번)을 **글꼴 + 벡터**로 조판한다(사진 없음).
 * 실행: OUT=결과.pdf npx tsx scripts/kice/problem-pilot.ts
 * 글꼴: 한글은 나눔명조(해설용 서브셋), 영문·숫자·수식은 Times 계열(Liberation Serif — 평가원 본문의 영문·수식이 Times 계열이다).
 * 실제 평가원 글꼴((한)신중명조 등)은 로그인 버킷에 있어 이 시험에서는 못 쓴다.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath, concatTransformationMatrix } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import { typesetEq, type EqBox } from "../../src/lib/kice/eqTypeset";

const BLACK = rgb(0, 0, 0);
type Piece =
  | { t: "text"; s: string }
  | { t: "eq"; tex: string }
  | { t: "frac"; top: string; bot: string }
  | { t: "circ"; s: string };
type Unit = Piece[];

// 평가원 본문 치수(원본 사진에서 잰 값: 단 폭 326.84pt 기준)
const S = 10.8; // 글자 크기
const PITCH = 17.4; // 줄 간격
const HSCALE = 0.98; // 장평(한글)
const LATIN = 1.07; // 영문·숫자는 Times 라 한글과 높이를 맞추려 조금 키운다
const BOX_TH = 0.45; // 보기 상자 선
const TABLE_TH = 0.5;

export async function build() {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync("public/fonts/solution-serif.ttf"), { subset: false });
  const digits = await pdf.embedFont(fs.readFileSync("public/fonts/number-digits.ttf"), { subset: false });
  const lat = await pdf.embedFont(fs.readFileSync("public/fonts/eq-serif.ttf"), { subset: false });
  const latI = await pdf.embedFont(fs.readFileSync("public/fonts/eq-serif-italic.ttf"), { subset: false });

  const isLatin = (c: string) => /[\u0020-\u007e\u00b0-\u00ff\u2032\u2212\u00d7\u00f7\u2264\u2265\u2260\u2192\u03b1-\u03c9\u0391-\u03a9]/.test(c);
  const wc = (c: string, size: number, italic = false) => {
    try {
      if (isLatin(c)) return (italic ? latI : lat).widthOfTextAtSize(c, size * LATIN) ;
      return font.widthOfTextAtSize(c, size) * HSCALE;
    } catch { return size * 0.5; }
  };
  /** 한 줄 글자를 한글/영문으로 나눠 폭을 잰다. */
  const W = (t: string, size = S, italic = false) => [...t].reduce((a, c) => a + wc(c, size, italic), 0);

  const withScale = (page: PDFPage, x: number, y: number, sx: number, fn: () => void) => {
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, 1, x, y));
    fn();
    page.pushOperators(popGraphicsState());
  };
  /** 글자 하나(한글은 장평 적용)를 그린다. */
  const drawChar = (page: PDFPage, c: string, x: number, y: number, size: number, bold: boolean, italic = false) => {
    for (const dx of bold ? [0, 0.3] : [0]) {
      if (isLatin(c)) page.drawText(c, { x: x + dx, y, size: size * LATIN, font: italic ? latI : lat, color: BLACK });
      else withScale(page, x + dx, y, HSCALE, () => page.drawText(c, { x: 0, y: 0, size, font, color: BLACK }));
    }
  };
  const text = (page: PDFPage, s: string, x: number, y: number, size = S, bold = false, italic = false) => {
    let cx = x;
    for (const c of s) {
      drawChar(page, c, cx, y, size, bold, italic);
      cx += wc(c, size, italic);
    }
  };
  const textNum = (page: PDFPage, s: string, x: number, y: number, size: number) => {
    for (const dx of [0, 0.45]) page.drawText(s, { x: x + dx, y, size, font: digits, color: BLACK });
  };
  const hline = (page: PDFPage, x1: number, y1: number, x2: number, y2: number, th = 0.6, dash?: number[]) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: BLACK, ...(dash ? { dashArray: dash } : {}) });

  // ---- 수식 ----
  const eqMetric = (s: string, size: number, style: "r" | "i") => W(s, size, style === "i");
  const eqCache = new Map<string, EqBox | null>();
  const eqOf = (tex: string): EqBox | null => {
    if (!eqCache.has(tex)) eqCache.set(tex, typesetEq(tex, S, eqMetric));
    return eqCache.get(tex)!;
  };
  const drawEq = (page: PDFPage, b: EqBox, x: number, base: number) => {
    for (const o of b.ops) {
      if (o.t === "text") text(page, o.s, x + o.x, base + o.y, o.size, false, o.style === "i");
      else hline(page, x + o.x1, base + o.y1, x + o.x2, base + o.y2, o.th);
    }
  };

  const pieceW = (p: Piece): number => {
    if (p.t === "text") return W(p.s);
    if (p.t === "eq") return eqOf(p.tex)?.w ?? W(p.tex);
    if (p.t === "frac") return Math.max(W(p.top), W(p.bot)) + 3;
    return S * 1.08;
  };
  const circDigit = new Set("①②③④⑤");
  const drawPiece = (page: PDFPage, p: Piece, x: number, base: number) => {
    if (p.t === "text") text(page, p.s, x, base);
    else if (p.t === "eq") {
      const b = eqOf(p.tex);
      if (b) drawEq(page, b, x, base);
      else text(page, p.tex, x, base);
    } else if (p.t === "frac") {
      const w = pieceW(p);
      text(page, p.top, x + (w - W(p.top)) / 2, base + S * 1.0);
      text(page, p.bot, x + (w - W(p.bot)) / 2, base - S * 0.82);
      hline(page, x, base + S * 0.33, x + w, base + S * 0.33, 0.5);
    } else if (circDigit.has(p.s)) {
      const d = S * 1.02;
      page.drawCircle({ x: x + d / 2 + 0.3, y: base + S * 0.34, size: d / 2, borderWidth: 0.5, borderColor: BLACK });
      const n = String("①②③④⑤".indexOf(p.s) + 1);
      page.drawText(n, { x: x + d / 2 + 0.3 - lat.widthOfTextAtSize(n, S * 0.78) / 2, y: base + S * 0.34 - S * 0.26, size: S * 0.78, font: lat, color: BLACK });
    } else {
      // ㉠ ㉡: 동그라미 + 자모(글꼴의 원문자 글리프는 획이 가늘고 작다)
      const d = S * 1.02;
      page.drawCircle({ x: x + d / 2 + 0.3, y: base + S * 0.34, size: d / 2, borderWidth: 0.5, borderColor: BLACK });
      const jm = "㉠㉡㉢㉣".indexOf(p.s) >= 0 ? "ㄱㄴㄷㄹ"["㉠㉡㉢㉣".indexOf(p.s)] : p.s;
      withScale(page, x + d / 2 + 0.3 - font.widthOfTextAtSize(jm, S * 0.74) * 0.5 * HSCALE, base + S * 0.34 - S * 0.25, HSCALE, () => page.drawText(jm, { x: 0, y: 0, size: S * 0.74, font, color: BLACK }));
    }
  };

  // ---- 문단: 어절 단위 줄바꿈 + 양쪽 맞춤 ----
  const GAP = S * 0.3;
  const unitW = (u: Unit) => u.reduce((a, p) => a + pieceW(p), 0);
  /** 문단을 그린다. `first`=첫 줄 들여쓰기. 마지막 줄 **아래 끝** y 를 돌려준다(줄 중심 = top + PITCH/2). */
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
      const extra = hasFrac ? S * 0.7 : 0;
      y += extra;
      const base = y + PITCH / 2 + S * 0.32; // 줄 중심에서 글자 기준선
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
      y += PITCH + extra;
    }
    return y;
  }
  const toUnits = (src: (string | Piece)[]): Unit[] => {
    const units: Unit[] = [];
    let cur: Unit = [];
    const push = () => { if (cur.length) { units.push(cur); cur = []; } };
    for (const item of src) {
      if (typeof item !== "string") { cur.push(item); continue; }
      for (const part of item.split(/( )/)) {
        if (part === " ") push();
        else if (part) cur.push({ t: "text", s: part });
      }
    }
    push();
    return units;
  };

  const TW = 326.84;
  const PAGE_W = TW + 60;
  const PAGE_H = 560;
  const X0 = 30;
  const fy = (page: PDFPage, y: number) => page.getHeight() - y;

  /** 문항 머리: 번호는 왼쪽 여백으로 조금 나오고 본문 첫 줄이 번호 뒤에서 시작한다. */
  function header(page: PDFPage, no: string, top: number, body: Unit[]) {
    const base = top + PITCH / 2 + S * 0.32;
    textNum(page, no.replace(".", ""), X0 - 11, fy(page, base), 15.5);
    for (const dx of [0, 0.45]) page.drawText(".", { x: X0 - 11 + digits.widthOfTextAtSize(no.replace(".", ""), 15.5) + 0.5 + dx, y: fy(page, base), size: 15.5, font: lat, color: BLACK });
    return paragraph(page, body, X0, top, TW, { first: 16 });
  }

  /** <보 기> 상자 — 제목이 윗선을 끊고 얹힌다. 항목 `[라벨, 단위들]`. 상자 아래 끝 y 를 돌려준다. */
  function boguBox(page: PDFPage, top: number, items: { label: string; units: Unit[] }[]) {
    let by = top + 9.5;
    for (const it of items) {
      text(page, it.label, X0 + 11.4, fy(page, by + PITCH / 2 + S * 0.32), S);
      by = paragraph(page, it.units, X0 + 29.7, by, TW - 29.7 - 11, { first: 0, hang: 0 });
    }
    const bot = by + 9.5;
    const L = X0;
    const R = X0 + TW;
    const title = "<보  기>";
    const tw = W(title, S * 1.06) + 4;
    const cx = (L + R) / 2;
    const ty = fy(page, top);
    hline(page, L, ty, cx - tw / 2, ty, BOX_TH);
    hline(page, cx + tw / 2, ty, R, ty, BOX_TH);
    hline(page, L, ty, L, fy(page, bot), BOX_TH);
    hline(page, R, ty, R, fy(page, bot), BOX_TH);
    hline(page, L, fy(page, bot), R, fy(page, bot), BOX_TH);
    text(page, title, cx - tw / 2 + 2, ty - S * 0.34, S * 1.06);
    return bot;
  }
  function choices(page: PDFPage, y: number, ch: string[]) {
    const xs = [0, 65.9, 131.3, 196.6, 262];
    ch.forEach((c, i) => {
      drawPiece(page, { t: "circ", s: "①②③④⑤"[i] }, X0 + xs[i], fy(page, y + S * 0.32));
      text(page, c, X0 + xs[i] + S * 1.75, fy(page, y + S * 0.32), S);
    });
  }

  // ================= 20번 =================
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    let y = 24;
    y = header(
      page,
      "20.",
      y,
      toUnits([
        "그림은 어느 지역의 지질 단면을, 표는 방사성 원소 Y의 함량(%)에 대한 방사성 원소 X의 함량(%)과 Y의 함량(%)에 대한 Y의 자원소 함량(%)을 시기별로 나타낸 것이다. 화성암 A는 X와 Y를 모두 포함하며, 현재 A에 포함된 X의 함량은 처음 양의 26%이다. 화성암 B의 절대 연령은 1억 년이다.",
      ]),
    );
    const figTop = y - PITCH / 2 + 20.5;
    const figW = 106;
    const figH = 75;
    drawGeoSection(page, X0 + 0.5, figTop, figW, figH);
    // 표(원본 비율: 폭 199pt, 행 16.4 / 35 / 34pt, 열 114 / 42 / 43pt)
    const tx = X0 + figW + 19.5;
    const tw = 199;
    const cols = [114, 42, 43];
    const rows = [16.4, 35, 34.6];
    const ty = figTop + 2.5;
    const tb = ty + rows.reduce((a, b) => a + b, 0);
    page.drawRectangle({ x: tx, y: fy(page, tb), width: tw, height: tb - ty, borderColor: BLACK, borderWidth: TABLE_TH });
    let acc = ty;
    for (const r of rows.slice(0, -1)) { acc += r; hline(page, tx, fy(page, acc), tx + tw, fy(page, acc), TABLE_TH); }
    let cx0 = tx;
    for (const c of cols.slice(0, -1)) { cx0 += c; hline(page, cx0, fy(page, ty), cx0, fy(page, tb), TABLE_TH); }
    const sz = 8.1;
    const cen = (s: string, cx: number, base: number, size = sz) => text(page, s, cx - W(s, size) / 2, base, size);
    const mid = (r: number) => ty + rows.slice(0, r).reduce((a, b) => a + b, 0) + rows[r] / 2;
    cen("암석 생성 이후 경과 시간", tx + cols[0] / 2, fy(page, mid(0) + 2.7));
    cen("2억 년", tx + cols[0] + cols[1] / 2, fy(page, mid(0) + 2.7));
    cen("3억 년", tx + cols[0] + cols[1] + cols[2] / 2, fy(page, mid(0) + 2.7));
    const fracCell = (top: string, bot: string, cx: number, m: number) => {
      const w = Math.max(W(top, sz), W(bot, sz)) + 6;
      cen(top, cx, fy(page, m - 3.3));
      cen(bot, cx, fy(page, m + 9.2));
      hline(page, cx - w / 2, fy(page, m), cx + w / 2, fy(page, m), 0.5);
    };
    fracCell("X의 함량(%)", "Y의 함량(%)", tx + cols[0] / 2, mid(1));
    fracCell("Y의 자원소 함량(%)", "Y의 함량(%)", tx + cols[0] / 2, mid(2));
    const c2 = tx + cols[0] + cols[1] / 2;
    cen("1", c2, fy(page, mid(1) - 3.3), 8.6);
    cen("2", c2, fy(page, mid(1) + 9.2), 8.6);
    hline(page, c2 - 5, fy(page, mid(1)), c2 + 5, fy(page, mid(1)), 0.5);
    cen("1", c2, fy(page, mid(2) + 3), 8.6);
    const c3 = tx + cols[0] + cols[1] + cols[2] / 2;
    const circCell = (jm: string, cx: number, m: number) => {
      text(page, "(", cx - 11, fy(page, m + 3), 8.6);
      drawPiece(page, { t: "circ", s: jm }, cx - S * 0.5, fy(page, m + 3));
      text(page, ")", cx + 7.5, fy(page, m + 3), 8.6);
    };
    circCell("㉠", c3, mid(1));
    circCell("㉡", c3, mid(2));

    const figBottom = Math.max(figTop + figH, tb);
    y = paragraph(
      page,
      toUnits(["이 자료에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? (단, X의 자원소는 X가, Y의 자원소는 Y가 붕괴하여 생성되었으며, 자원소 함량(%)은 붕괴한 방사성 원소 함량과 같다. 방사성 원소의 함량(%)은 처음 양에 대한 남아 있는 양의 비율이다.) [3점]"]),
      X0,
      figBottom + 19.4 - PITCH / 2,
      TW,
      { first: 16 },
    );
    const bot = boguBox(page, y - PITCH / 2 + 24, [
      { label: "ㄱ.", units: toUnits(["단층 ", { t: "eq", tex: "f\\!-\\!f'" }, "은 고생대에 형성되었다."]) },
      { label: "ㄴ.", units: toUnits([{ t: "circ", s: "㉡" }, "은 ", { t: "circ", s: "㉠" }, "의 5배보다 크다."]) },
      {
        label: "ㄷ.",
        units: toUnits([
          "현재로부터 Y의 반감기가 1회 지났을 때, A에 포함된 ",
          { t: "frac", top: "X의 자원소 함량(%)", bot: "Y의 자원소 함량(%)" },
          "은 1.2보다 작다.",
        ]),
      },
    ]);
    choices(page, bot + 11.4, ["ㄱ", "ㄴ", "ㄷ", "ㄱ, ㄴ", "ㄴ, ㄷ"]);
  }

  // ================= 13번 =================
  {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    let y = 24;
    y = header(page, "13.", y, toUnits(["그림은 A와 B 시기에 지표로부터 1.5km 부근에서 대기 대순환에 의해 부는 바람의 남북 방향의 평균 풍속을 나타낸 것이다."]));
    const figTop = y - PITCH / 2 + 27;
    drawWindPanels(page, X0, figTop, TW);
    y = paragraph(page, toUnits(["이 자료에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? [3점]"]), X0, figTop + 118 + 16, TW, { first: 16 });
    const bot = boguBox(page, y - PITCH / 2 + 24, [
      { label: "ㄱ.", units: toUnits([{ t: "circ", s: "㉠" }, "의 지표 부근에서는 대기 대순환에 의한 공기의 발산이 나타난다."]) },
      { label: "ㄴ.", units: toUnits([{ t: "circ", s: "㉡" }, "의 해역에서 표층 해류의 아열대 순환은 시계 반대 방향으로 나타난다."]) },
      { label: "ㄷ.", units: toUnits(["지표 부근에서 해들리 순환의 상승 기류는 A가 B보다 저위도에서 나타난다."]) },
    ]);
    choices(page, bot + 11.4, ["ㄱ", "ㄷ", "ㄱ, ㄴ", "ㄴ, ㄷ", "ㄱ, ㄴ, ㄷ"]);
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
    text(page, "f", ox + 90 * sx, fy(page, oy + 76 * sy + 0), 8, false, true);
    text(page, "f′", ox + 420 * sx, fy(page, oy + 345 * sy), 8, false, true);
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
