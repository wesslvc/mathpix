/** `figureDsl` 의 그리기 명령을 pdf-lib 쪽에 그린다. 글자는 부르는 쪽이 글꼴로 그려 준다(`FigText`). */
import {
  PDFPage,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  closePath,
  clip,
  endPath,
  fill,
  stroke,
  fillAndStroke,
  setFillingGrayscaleColor,
  setStrokingGrayscaleColor,
  setLineWidth,
  setDashPattern,
  setLineCap,
  setLineJoin,
  LineCapStyle,
  LineJoinStyle,
  rgb,
} from "pdf-lib";
import type { FigOp, FigureOps, Pt } from "./figureDsl";

export type FigText = {
  /** 글자를 (x,y)=기준선 왼쪽/가운데/오른쪽 에 그린다. 크기는 pt. */
  text(page: PDFPage, s: string, x: number, y: number, size: number, o: { italic?: boolean; bold?: boolean; anchor?: "l" | "c" | "r"; vertical?: boolean }): void;
  /** 원문자(㉠ 등): 동그라미 + 자모. */
  circ(page: PDFPage, ch: string, cx: number, cy: number, size: number): void;
};

/** `fig` 를 왼쪽 위 (x, top) 에 폭 `width`pt 로 그린다. 그린 높이(pt)를 돌려준다. */
export function drawFigure(page: PDFPage, fig: FigureOps, x: number, top: number, width: number, ft: FigText): number {
  const k = width / fig.w;
  const H = page.getHeight();
  const px = (p: number) => x + p * k;
  const py = (p: number) => H - (top + p * k);
  const path = (pts: Pt[], close: boolean) => {
    const o = [moveTo(px(pts[0][0]), py(pts[0][1]))];
    for (let i = 1; i < pts.length; i++) o.push(lineTo(px(pts[i][0]), py(pts[i][1])));
    if (close) o.push(closePath());
    return o;
  };
  const run = (ops: FigOp[]) => {
    for (const o of ops) {
      switch (o.t) {
        case "poly": {
          if (o.pts.length < 2) break;
          const ops2 = [pushGraphicsState()];
          if (o.fill !== undefined) ops2.push(setFillingGrayscaleColor(o.fill));
          if (o.stroke !== undefined) {
            ops2.push(setStrokingGrayscaleColor(0), setLineWidth(o.stroke * k), setLineJoin(LineJoinStyle.Round));
            if (o.dash) ops2.push(setDashPattern([o.dash[0] * k, o.dash[1] * k], 0));
          }
          ops2.push(...path(o.pts, o.close ?? true));
          ops2.push(o.fill !== undefined && o.stroke !== undefined ? fillAndStroke() : o.fill !== undefined ? fill() : stroke());
          ops2.push(popGraphicsState());
          page.pushOperators(...ops2);
          break;
        }
        case "rect": {
          run([{ t: "poly", pts: [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]], fill: o.fill, stroke: o.stroke, close: true }]);
          break;
        }
        case "line": {
          if (o.pts.length < 2) break;
          const ops2 = [pushGraphicsState(), setStrokingGrayscaleColor(0), setLineWidth(o.th * k), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
          if (o.dash) ops2.push(setDashPattern([o.dash[0] * k, o.dash[1] * k], 0), setLineCap(LineCapStyle.Butt));
          ops2.push(...path(o.pts, false), stroke(), popGraphicsState());
          page.pushOperators(...ops2);
          break;
        }
        case "ellipse":
          page.drawEllipse({ x: px(o.x), y: py(o.y), xScale: o.rx * k, yScale: o.ry * k, color: rgb(o.fill ?? 0, o.fill ?? 0, o.fill ?? 0) });
          break;
        case "text":
          ft.text(page, o.s, px(o.x), py(o.y), o.size * k, { italic: o.italic, bold: o.bold, anchor: o.anchor, vertical: o.vertical });
          break;
        case "circ":
          ft.circ(page, o.ch, px(o.x), py(o.y), o.size * k);
          break;
        case "group":
          page.pushOperators(pushGraphicsState(), ...path(o.clip, true), clip(), endPath());
          run(o.ops);
          page.pushOperators(popGraphicsState());
          break;
      }
    }
  };
  run(fig.ops);
  return fig.h * k;
}
