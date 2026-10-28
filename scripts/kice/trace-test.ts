import sharp from "sharp";
import fs from "fs";
import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, PDFOperator, setFillingColor } from "pdf-lib";
import { traceFigure } from "../../src/lib/kice/traceFigure";
(async () => {
  const { data, info } = await sharp(process.env.IN!).greyscale().raw().toBuffer({ resolveWithObject: true });
  const t0 = Date.now();
  const fig = traceFigure(new Uint8Array(data), info.width, info.height);
  console.log("size", info.width, info.height, "paths", fig.paths.length, "pts", fig.paths.reduce((a, p) => a + p.length, 0), "ms", Date.now() - t0);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([info.width, info.height]);
  const ops = [pushGraphicsState(), setFillingColor(rgb(0, 0, 0))];
  for (const p of fig.paths) {
    p.forEach(([x, y], i) => ops.push(i ? lineTo(x, info.height - y) : moveTo(x, info.height - y)));
    ops.push(closePath());
  }
  ops.push(PDFOperator.of("f*" as never), popGraphicsState());
  page.pushOperators(...ops);
  fs.writeFileSync(process.env.OUT!, await pdf.save());
})();
