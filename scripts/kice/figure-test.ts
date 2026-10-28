/**
 * 도식 DSL 시험 — 스펙(JSON)을 평가원 규격으로 그려 PDF 로 만든다.
 * 실행: SPEC=스펙.json OUT=결과.pdf npx tsx scripts/kice/figure-test.ts
 */
import { PDFDocument, PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import { renderFigure, type FigureSpec } from "../../src/lib/kice/figureDsl";
import { runFigureScript } from "../../src/lib/kice/figureScript";
import { drawFigure, type FigText } from "../../src/lib/kice/figureDraw";

(async () => {
  const fig = process.env.SCRIPT
    ? runFigureScript(fs.readFileSync(process.env.SCRIPT, "utf8"))
    : renderFigure(JSON.parse(fs.readFileSync(process.env.SPEC!, "utf8")) as FigureSpec);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync("public/fonts/solution-serif.ttf"), { subset: false });
  const lat = await pdf.embedFont(fs.readFileSync("public/fonts/eq-serif.ttf"), { subset: false });
  const latI = await pdf.embedFont(fs.readFileSync("public/fonts/eq-serif-italic.ttf"), { subset: false });
  const isLatin = (c: string) => /[ -~°-ÿ→↑−]/.test(c);
  const wOf = (s: string, size: number, italic?: boolean) =>
    [...s].reduce((a, c) => a + (isLatin(c) ? (italic ? latI : lat).widthOfTextAtSize(c, size * 1.05) : font.widthOfTextAtSize(c, size) * 0.97), 0);
  const put = (page: PDFPage, c: string, x: number, y: number, size: number, italic?: boolean, bold?: boolean) => {
    for (const dx of bold ? [0, size * 0.03] : [0]) {
      if (isLatin(c)) page.drawText(c, { x: x + dx, y, size: size * 1.05, font: italic ? latI : lat, color: rgb(0, 0, 0) });
      else page.drawText(c, { x: x + dx, y, size, font, color: rgb(0, 0, 0), xSkew: undefined });
    }
  };
  const ft: FigText = {
    text(page, s, x, y, size, o) {
      if (o.vertical) {
        let cy = y + (s.length * size * 1.05) / 2;
        for (const c of s) {
          put(page, c, x - wOf(c, size) / 2, cy - size, size, o.italic, o.bold);
          cy -= size * 1.12;
        }
        return;
      }
      const w = wOf(s, size, o.italic);
      let cx = o.anchor === "c" ? x - w / 2 : o.anchor === "r" ? x - w : x;
      for (const c of s) {
        put(page, c, cx, y, size, o.italic, o.bold);
        cx += wOf(c, size, o.italic);
      }
    },
    circ(page, ch, cx, cy, size) {
      page.drawCircle({ x: cx, y: cy, size: size * 0.55, borderWidth: size * 0.05, borderColor: rgb(0, 0, 0) });
      const jm = "㉠㉡㉢㉣".indexOf(ch) >= 0 ? "ㄱㄴㄷㄹ"["㉠㉡㉢㉣".indexOf(ch)] : ch;
      const w = font.widthOfTextAtSize(jm, size * 0.72) * 0.97;
      page.pushOperators();
      page.drawText(jm, { x: cx - w / 2, y: cy - size * 0.26, size: size * 0.72, font, color: rgb(0, 0, 0) });
    },
  };
  const WIDTH = Number(process.env.WIDTH ?? 1000);
  const page = pdf.addPage([WIDTH + 20, (fig.h * WIDTH) / fig.w + 20]);
  drawFigure(page, fig, 10, 10, WIDTH, ft);
  fs.writeFileSync(process.env.OUT!, await pdf.save());
})();
