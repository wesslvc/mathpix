import { enhanceContrast } from "./autoContrast";

// 사과탐 자료를 LLM에 보내기 전에 브라우저에서 처리하는 것들.
// 여기서 하는 일은 전부 공짜이고, 목적은 "LLM 호출을 줄이고, 부를 때는 싸게"다.
//
// ── 자동 판별을 넣지 않은 이유 (다시 시도하려는 다음 사람에게) ─────────────
// 처음에는 "사진형 자료는 재구성해봐야 손해니 호출 자체를 막자"는 판별기를
// 넣으려 했다. 픽셀 통계로 선화/사진을 가르는 시도를 두 가지 해봤고 둘 다 실패했다.
//   1) 국소 평탄도(이웃 픽셀과 같은 색인 비율): 부드러운 그라디언트 사진이
//      1.00으로 선화(0.90~0.95)보다 오히려 높게 나온다. 그라디언트는 국소적으로
//      가장 평탄하다 — 전제가 틀렸다.
//   2) 상위 N개 색의 화면 점유율: 대부분 잘 갈라지지만 "색칠된 지층 단면도를
//      어두운 조명에서 찍은 사진"이 0.59로 사진 범위(≤0.63)에 파묻힌다.
//      조명 기울기가 단색 띠를 여러 색으로 흩어놓기 때문이고, 이건 실제로 흔한 자료다.
// 어느 임계값을 잡아도 정상 자료를 막거나 사진을 통과시킨다. 오판의 대가가
// (막으면 기능 불능, 통과시키면 돈 낭비) 판별기의 이득보다 커서 뺐다.
// 대신 무료 경로(rasterToSvg)를 기본으로 앞에 두고 사용자가 고르게 한다.

/** 모델에 보낼 이미지의 긴 변 상한. 작을수록 입력 토큰이 싸다. */
export const MODEL_INPUT_DIM = 768;

/**
 * 문제 **전체**를 보낼 때의 상한.
 *
 * 그림 하나는 768px로 충분하지만, 문제 한 장에는 본문·선지까지 들어 있어서
 * 같은 크기로 줄이면 글자가 뭉개진다. 모델이 못 읽은 글자는 지어내므로
 * (그리고 결과가 이미지라 나중에 고칠 수도 없으므로) 여기서 아끼면 안 된다.
 */
export const PROBLEM_INPUT_DIM = 1536;

/**
 * 문제 전체를 보낼 때의 **높이** 상한.
 *
 * 문제 전체는 긴 변이 아니라 **폭**을 지켜야 한다 — 글자 크기가 폭으로
 * 정해지기 때문이다. 세로로 긴 문제(단을 넘어 이어 붙인 것이 특히 그렇다)를
 * 긴 변 기준으로 줄이면 폭이 800px 아래로 떨어져 본문이 뭉개지고, 모델이
 * 못 읽은 글자를 지어낸다. 그래서 폭을 먼저 맞추고 높이는 여기까지만 본다.
 */
export const PROBLEM_MAX_HEIGHT = 3000;

/**
 * 영역을 **찾을 때** 보내는 이미지의 긴 변 상한.
 *
 * 자리를 재는 일이라 작아도 될 것 같지만, 지면 한 장에 문제가 열 몇 개 들어
 * 있으면 문제 하나가 화면의 몇 %밖에 안 된다. 작게 보내면 경계를 대충 잡는다.
 * 그래서 **원본에 가깝게** 보낸다.
 *
 * 다만 무한정 키울 수는 없다 — 서버로 올라가는 요청 본문에 상한이 있어서
 * (Vercel 은 4.5MB) 넘으면 요청 자체가 실패한다. 그래서 `fitForUpload` 가
 * 실제 크기를 보고 단계적으로 낮춘다.
 */
export const DETECT_INPUT_DIM = 3000;

/** 요청 본문으로 안전한 data URL 길이(글자 수 ≈ 바이트). */
export const MAX_UPLOAD_CHARS = 3_400_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = src;
  });
}

/**
 * 모델에 보낼 이미지를 만든다. 긴 변을 MODEL_INPUT_DIM으로 줄여 입력 토큰을
 * 줄이되, 라벨 글자가 뭉개지지 않을 만큼은 남긴다. 사과탐 자료는 글자를 못
 * 읽으면 재구성 자체가 무의미하므로 이보다 더 줄이지는 않는다.
 *
 * 이미 그보다 작으면 확대하지 않는다 — 없던 정보가 생기지도 않으면서 토큰만 는다.
 */
export async function prepareFigureForModel(
  dataUrl: string,
  maxDim: number = MODEL_INPUT_DIM,
): Promise<string> {
  dataUrl = await enhanceContrast(dataUrl);
  const img = await loadImage(dataUrl);
  if (Math.max(img.naturalWidth, img.naturalHeight) <= maxDim) {
    return dataUrl;
  }
  const scale = maxDim / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * 문제 **전체**를 보낼 때 쓰는 축소.
 *
 * `prepareFigureForModel`과 달리 **폭을 기준**으로 맞춘다(위 상수 주석 참고).
 * 원본보다 키우지는 않는다 — 없는 해상도는 만들어지지 않는다.
 */
export async function prepareProblemForModel(dataUrl: string): Promise<string> {
  // 손으로 찍은 사진은 종이가 회색이라 글자가 옅다. 보내기 전에 한 번 편다.
  dataUrl = await enhanceContrast(dataUrl);
  const img = await loadImage(dataUrl);
  const scale = Math.min(
    1,
    PROBLEM_INPUT_DIM / img.naturalWidth,
    PROBLEM_MAX_HEIGHT / img.naturalHeight,
  );
  if (scale >= 1) return dataUrl;

  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** 이 밝기 이상이면 "빈 여백"으로 본다(0~255). */
const BLANK_LUMINANCE = 244;

/**
 * 그림 둘레의 빈 여백을 잘라낸다.
 *
 * 이미지 생성 모델은 요청한 자료가 가로로 길든 세로로 길든 자기 비율(대개
 * 정사각형)에 맞춰 그려서, 실제 그림 둘레에 흰 여백을 잔뜩 붙여 돌려준다.
 * 그대로 문제에 끼우면 그림보다 여백이 더 커져서 문단 사이가 갑자기 휑하게
 * 벌어진다. 내용이 있는 부분만 남기고 잘라낸다.
 *
 * 자를 게 없거나(이미 꽉 찬 그림) 거의 다 비어 보이면 원본을 그대로 돌려준다.
 */
export async function trimBlankBorder(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w === 0 || h === 0) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return dataUrl;
  // 배경을 흰색으로 깔아 투명한 여백도 빈 곳으로 취급되게 한다.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);

  const { data } = ctx.getImageData(0, 0, w, h);
  let top = -1;
  let bottom = -1;
  let left = w;
  let right = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < BLANK_LUMINANCE) {
        if (top === -1) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (top === -1 || right < left) return dataUrl; // 전부 비어 있다

  // 잘라낸 뒤 숨 쉴 틈을 조금 남긴다(선이 테두리에 딱 붙으면 답답하다).
  const pad = Math.round(Math.min(w, h) * 0.02);
  const x0 = Math.max(0, left - pad);
  const y0 = Math.max(0, top - pad);
  const x1 = Math.min(w, right + 1 + pad);
  const y1 = Math.min(h, bottom + 1 + pad);
  const cw = x1 - x0;
  const ch = y1 - y0;

  // 거의 안 잘리면 굳이 다시 인코딩하지 않는다.
  if (cw >= w * 0.98 && ch >= h * 0.98) return dataUrl;

  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  if (!octx) return dataUrl;
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, cw, ch);
  octx.drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
  return out.toDataURL("image/png");
}

/**
 * 오려낸 원본 이미지를 SVG로 감싼다.
 *
 * LLM을 한 번도 부르지 않는 무료 경로이면서, 결과가 재구성된 SVG와 똑같은
 * 모양(문자열 하나)이라 크기·위치 조절, PNG 캡처, 저장 경로를 그대로 탄다.
 * 사진·현미경 사진·지도처럼 다시 그리면 정보가 사라지는 자료에는 이게 정답이다.
 */
export async function rasterToSvg(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  // href와 xlink:href를 모두 넣는다. 최신 브라우저는 href를 쓰지만, SVG를
  // 문자열로 직렬화해 다루는 캡처 라이브러리 중에 아직 xlink만 보는 것이 있다.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}">` +
    `<image href="${dataUrl}" xlink:href="${dataUrl}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`
  );
}

/**
 * 그림 마크업에서 **원본 이미지를 도로 꺼낸다.**
 *
 * 수정 화면에서 붙어 있는 그림을 다시 오려내거나 AI 로 다시 그리려면 원본
 * 픽셀이 필요한데, 저장된 것은 마크업뿐이라 거기서 되꺼낸다.
 * `rasterToSvg` 가 감싼 `<svg><image href=…>` 와 옛 형태인 `<img src=…>` 를
 * 둘 다 받는다(꺼낼 수 없으면 null — 그때는 다시 그리기 단추를 보여주지 않는다).
 */
export function rasterFromSvg(markup: string): string | null {
  const m = markup.match(/(?:href|src)="(data:image\/[^"]+)"/);
  return m ? m[1] : null;
}

/**
 * 여러 조각을 **세로로 이어 붙여 한 장으로** 만든다.
 *
 * 모의고사 지면에서는 문제 하나가 왼쪽 단 아래에서 시작해 오른쪽 단 위로
 * 이어진다. 읽는 차례대로 위에서 아래로 쌓으면 원래 한 문제가 된다.
 *
 * 조각마다 폭이 조금씩 다르므로 **가장 넓은 조각에 폭을 맞춘다**(좁은 것을
 * 늘리는 쪽이다 — 넓은 것을 줄이면 글자가 작아져 읽기 나빠진다).
 * 사이는 **아주 좁게** 둔다(글줄 사이 정도). 원래 한 문제였던 것이므로 두
 * 조각이 떨어져 보이면 안 된다 — 글줄이 맞붙지 않을 만큼만 띄운다.
 */
export async function stitchVertically(dataUrls: string[]): Promise<string> {
  if (dataUrls.length === 0) throw new Error("이어 붙일 조각이 없습니다.");
  if (dataUrls.length === 1) return dataUrls[0];

  const imgs = await Promise.all(dataUrls.map((u) => loadImage(u)));
  const width = Math.max(...imgs.map((i) => i.naturalWidth));
  const gap = Math.max(2, Math.round(width * 0.004));
  const heights = imgs.map((i) => Math.round((i.naturalHeight * width) / i.naturalWidth));
  const height = heights.reduce((a, b) => a + b, 0) + gap * (imgs.length - 1);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  let y = 0;
  imgs.forEach((img, i) => {
    ctx.drawImage(img, 0, y, width, heights[i]);
    y += heights[i] + gap;
  });
  return canvas.toDataURL("image/jpeg", 0.9);
}
