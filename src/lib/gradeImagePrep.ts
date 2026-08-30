import { cropImageToDataUrl, loadDrawableFromFile, loadImage } from "./cropImage";
import { enhanceContrast } from "./autoContrast";
import { DETECT_INPUT_DIM, MAX_UPLOAD_CHARS } from "./figureImage";

/**
 * OMR·정답표 사진을 채점 모델에 보낼 크기로 줄인다.
 *
 * OMR의 마킹, 정답표의 작은 숫자는 지면 전체에서 아주 작은 자리를 차지하므로
 * `detectImage`(문제 영역 찾기)와 같은 이유로 **되도록 크게** 보내되, 요청
 * 본문 상한(Vercel 4.5MB)에 걸리지 않게 실제 길이를 보고 한 단씩 낮춘다.
 *
 * 채점 한 번에 사진이 여러 장(탐구는 3장)일 수 있어 **장당 예산을 나눈다** —
 * 한 장 기준 상한(`MAX_UPLOAD_CHARS`)을 그대로 여러 장에 쓰면 요청이 통째로
 * 실패한다.
 */
/**
 * 고르는 순간 **바이트까지 읽어 둔** 사진.
 *
 * 안드로이드에서는 갤러리로 고른 파일이 `content://` 로 넘어오는데, 그 접근
 * 권한이 시간이 지나면 풀린다 — 사진을 고른 뒤 과목·이름을 채우고 "채점하기"를
 * 누를 때쯤이면 이미 못 읽는 파일이 되어 있는 일이 있다(그래서 될 때도 있고
 * 안 될 때도 있었다). 그래서 **고르는 그 자리에서** data URL 로 읽어 두고,
 * 그 뒤로는 이 값만 쓴다.
 *
 * `file` 도 함께 들고 있는 것은 큰 사진을 디코딩하면서 줄이는
 * `createImageBitmap` 이 Blob 을 받기 때문이다 — 그쪽이 실패해도 `dataUrl`
 * 이 있으니 보낼 것은 언제나 있다.
 */
export type PickedImage = { name: string; dataUrl: string; file?: File };

export async function prepareGradingImage(
  pic: PickedImage,
  budgetChars: number,
): Promise<string> {
  const file = pic.file;

  // ① 브라우저가 사진을 열 수 있으면 줄여서 보낸다. 가장 좋은 길이다 —
  //    크기를 우리가 정하니 예산 안에 확실히 들어간다.
  try {
    const img = file
      ? await loadDrawableFromFile(file)
      : await (async () => {
          const el = await loadImage(pic.dataUrl);
          return {
            src: el as CanvasImageSource,
            width: el.naturalWidth,
            height: el.naturalHeight,
            close: () => {},
          };
        })();
    try {
      const whole = { x: 0, y: 0, width: img.width, height: img.height };
      let last = "";
      for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
        last = cropImageToDataUrl(img.src, whole, { maxWidth: dim, maxHeight: dim });
        if (last.length <= budgetChars) break;
      }
      if (!last) throw new Error("사진을 줄이지 못했습니다.");

      // 대비를 올리면 흐린 필기·옅은 마킹이 또렷해진다. 크기를 맞춘 뒤에 한다
      // (전에 하면 늘린 값이 다시 뭉개진다). enhanceContrast 는 실패해도
      // 원본을 그대로 돌려주므로 여기서 따로 감쌀 것이 없다.
      const enhanced = await enhanceContrast(last);
      return enhanced.length <= budgetChars ? enhanced : last;
    } finally {
      // ImageBitmap 은 닫아야 메모리가 바로 풀린다. 사진 세 장을 잇달아
      // 처리하므로 안 닫으면 큰 사진에서 그대로 쌓인다.
      img.close();
    }
  } catch {
    // ② 못 열면 **원본 바이트를 그대로** 보낸다. 디코딩은 모델이 한다.
    //
    //    브라우저가 사진을 못 여는 기기가 실제로 있다(안드로이드에서
    //    갤러리·구글포토를 거쳐 온 파일이 그렇다 — 12MP 사진도, 화면
    //    캡처도 똑같이 안 열렸다). 예전에는 그때 채점이 통째로 막혔는데,
    //    **우리가 사진을 그릴 수 있어야 할 이유가 없다** — 읽어서 넘기기만
    //    하면 되고, 바이트를 base64 로 옮기는 일은 디코딩이 필요 없어서
    //    그런 기기에서도 성공한다.
    //
    //    대신 크기를 줄일 수 없으니 예산을 넘으면 그때는 알려줘야 한다.
  }

  // **여기서 파일을 다시 읽지 않는다.** 고를 때 이미 읽어 둔 바이트를 쓴다 —
  // 다시 읽으면 그 사이 접근 권한이 풀린 안드로이드 파일에서 실패한다
  // (실제로 "파일을 읽지 못했습니다"로 채점이 막혔다).
  if (pic.dataUrl.length <= budgetChars) return pic.dataUrl;

  const mb = ((pic.dataUrl.length * 3) / 4 / (1024 * 1024)).toFixed(1);
  throw new Error(
    `"${pic.name}" 사진을 이 브라우저에서 열지 못했고, 원본을 그대로 보내기엔 너무 큽니다 (약 ${mb}MB). ` +
      `카메라 설정에서 해상도를 낮춰 다시 찍거나, 사진을 편집·캡처해서 더 작게 만든 뒤 올려주세요.`,
  );
}

/** 이번 요청에 쓸 이미지 장수로 전체 예산을 나눈다. */
export function gradingImageBudget(imageCount: number): number {
  return Math.floor(MAX_UPLOAD_CHARS / Math.max(1, imageCount));
}
