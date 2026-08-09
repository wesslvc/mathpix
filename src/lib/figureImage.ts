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
export async function prepareFigureForModel(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  if (Math.max(img.naturalWidth, img.naturalHeight) <= MODEL_INPUT_DIM) {
    return dataUrl;
  }
  const scale = MODEL_INPUT_DIM / Math.max(img.naturalWidth, img.naturalHeight);
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
