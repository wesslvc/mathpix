import { PROBLEM_CARD_WIDTH } from "../layout";

/**
 * 저장된 문제 이미지에 **구워져 있는 카드 테두리**를 지운다.
 *
 * 인식 결과 화면의 카드에는 회색 테두리와 둥근 모서리가 걸려 있는데, 그건
 * 화면 장치인데도 캡처하면 PNG 에 그대로 찍힌다. 지금은 캡처할 때 투명하게
 * 처리하지만(`CARD_CAPTURE_OPTIONS`) **그 전에 저장된 문제들에는 이미 구워져
 * 있다.** 평가원 문제지 양식에서는 실제 문제지에 없는 네모가 문항마다 생기므로
 * 내보낼 때 한 번 더 지운다.
 *
 * 지우는 방법은 가장자리를 흰색으로 덮는 것이다. 잘라내지 않는 이유는 **둥근
 * 모서리** 때문이다 — 테두리 두께만큼만 잘라내면 네 귀퉁이의 굽은 자국이
 * 그대로 남는다. 덮는 폭은 굽은 부분을 넉넉히 감싸면서도 카드 안쪽 여백
 * (`p-8`, 32 CSS px)보다는 훨씬 좁아서 본문을 건드리지 않는다.
 *
 * 그리고 **테두리가 있을 때만** 덮는다. 아무 이미지에나 흰 띠를 두르면 테두리
 * 없이 저장된 문제의 가장자리 내용이 날아간다.
 */

/** 덮을 폭(이미지 픽셀). 카드 여백의 절반쯤 되게 잡는다. */
const BAND_RATIO = 18 / PROBLEM_CARD_WIDTH;

export async function stripCardBorder(png: Uint8Array): Promise<Uint8Array> {
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  try {
    const bitmap = await createImageBitmap(new Blob([png.slice().buffer]));
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) return png;
    ctx = c;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } catch {
    // 못 읽으면 원본을 그대로 쓴다 — 테두리를 지우자고 문제를 잃을 수는 없다.
    return png;
  }

  const w = canvas.width;
  const h = canvas.height;
  const band = Math.max(2, Math.round(w * BAND_RATIO));
  // 띠가 그림을 통째로 덮을 만큼 작은 이미지는 손대지 않는다.
  if (w < band * 3 || h < band * 3) return png;

  // 가장자리 한가운데를 찍어 본다. 테두리가 있으면 흰색이 아니다.
  const marked = (x: number, y: number) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    // 완전히 투명한 점(둥근 모서리 바깥)은 테두리가 아니다.
    return d[3] > 8 && (d[0] < 245 || d[1] < 245 || d[2] < 245);
  };
  const mid = { x: w >> 1, y: h >> 1 };
  if (!(marked(1, mid.y) || marked(mid.x, 1) || marked(w - 2, mid.y) || marked(mid.x, h - 2))) {
    return png;
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, band);
  ctx.fillRect(0, h - band, w, band);
  ctx.fillRect(0, 0, band, h);
  ctx.fillRect(w - band, 0, band, h);

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : png;
}
