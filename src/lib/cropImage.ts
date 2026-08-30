import type { CropRect } from "./types";

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.9;

/**
 * 원본 이미지에서 주어진 영역(원본 픽셀 좌표 기준)을 잘라 data URL로 반환한다.
 * 실제 카메라 사진은 무압축 PNG로 인코딩하면 문자열이 수십 MB까지 커져
 * 일부 모바일 브라우저(특히 Safari)에서 요청 자체가 실패하는 경우가 있어,
 * 긴 변을 MAX_DIMENSION 이하로 축소하고 JPEG로 압축해 전송 크기를 줄인다.
 */
export function cropImageToDataUrl(
  // `<img>` 뿐 아니라 `ImageBitmap` 도 받는다(큰 사진은 그쪽으로 연다 —
  // loadDrawableFromFile 참고). 이 함수는 크기를 rect 로만 받으므로 둘의
  // 차이가 없다.
  image: CanvasImageSource,
  rect: CropRect,
  /**
   * 가로·세로를 따로 제한하고 싶을 때.
   *
   * 기본값은 **긴 변** 기준인데, 세로로 긴 문제에서는 그러면 폭이 무너진다
   * (글자 크기는 폭으로 정해진다). 문제 전체를 모델에 보낼 때는 폭을 지켜야
   * 해서 이 길로 부른다.
   */
  limits?: { maxWidth: number; maxHeight: number },
): string {
  const cropWidth = Math.max(1, Math.round(rect.width));
  const cropHeight = Math.max(1, Math.round(rect.height));

  const scale = limits
    ? Math.min(1, limits.maxWidth / cropWidth, limits.maxHeight / cropHeight)
    : Math.min(1, MAX_DIMENSION / Math.max(cropWidth, cropHeight));
  const outWidth = Math.max(1, Math.round(cropWidth * scale));
  const outHeight = Math.max(1, Math.round(cropHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");

  ctx.drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    outWidth,
    outHeight,
  );

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

const HEIC_PATTERN = /\.(heic|heif)$/i;

export function isHeicFile(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    HEIC_PATTERN.test(file.name)
  );
}

/**
 * 사용자가 새로 찍거나 고른 사진 파일을 화면에 띄울 수 있는 data URL로 바꾼다.
 * 카메라 원본은 수천 px이라 그대로 data URL로 만들면 문자열이 수십 MB가 되어
 * Safari에서 터진다 — 크롭할 때와 같은 기준(긴 변 1600px, JPEG)으로 줄인다.
 */
export async function fileToDataUrl(file: File): Promise<string> {
  if (isHeicFile(file)) {
    throw new Error(
      "HEIC/HEIF 형식은 브라우저에서 열 수 없습니다. 아이폰 설정 > 카메라 > 포맷을 '호환 우선'으로 바꾼 뒤 다시 찍어주세요.",
    );
  }
  if (!file.type.startsWith("image/")) {
    throw new Error("이미지 파일만 사용할 수 있습니다.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(
      1,
      MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 파일의 바이트를 실제로 읽어 data URL로 만든다(objectURL 과 다른 경로다).
 *
 * **디코딩을 하지 않는다** — 그냥 바이트를 base64 로 옮길 뿐이다. 그래서
 * 브라우저가 그 형식을 못 그리더라도 이건 성공한다. 사진을 화면에 못 여는
 * 기기에서도 모델에는 보낼 수 있는 이유다(`prepareGradingImage` 참고).
 */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error(`"${file.name}" 파일을 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });
}

/** 캔버스에 그릴 수 있는 이미지와 그 크기. `<img>` 든 `ImageBitmap` 이든 같이 다룬다. */
export type Drawable = {
  src: CanvasImageSource;
  width: number;
  height: number;
  /** ImageBitmap 은 다 쓰면 닫아야 메모리가 바로 풀린다. */
  close: () => void;
};

/**
 * 이 크기를 넘는 사진은 **디코딩하면서 바로 줄인다**.
 *
 * 갤럭시 카메라는 5천만~2억 화소로 찍는다(예: 200MP = 16320×12240). 그런
 * 사진을 `<img>` 로 열면 **원본 픽셀을 전부 메모리에 펴야 해서** 모바일
 * 크롬이 디코딩 자체를 포기한다(200MP면 RGBA 로 약 800MB다). 그때
 * `img.onerror` 가 떠서, 멀쩡한 JPG 인데도 "이미지를 불러오지 못했습니다"가
 * 됐다 — 실제로 사용자가 갤럭시 카메라 사진으로 여기서 막혔다.
 *
 * `createImageBitmap` 에 `resizeWidth` 를 주면 JPEG 디코더가 **줄인 크기로
 * 곧바로 디코딩**하므로 원본 크기의 메모리가 아예 필요 없다. 어차피
 * `DETECT_INPUT_DIM`(3000) 이하로 줄여 보낼 것이라 화질 손해도 없다.
 */
const DECODE_MAX_DIM = 3000;

/**
 * 사용자가 고른 사진 파일을 **여러 방법으로** 열어 본다. 하나라도 되면 그걸 쓴다.
 *
 * `URL.createObjectURL` + `<img>` 한 가지만 쓰면 안드로이드에서 자주 실패한다:
 * ① **사진이 너무 크다**(갤럭시 카메라 원본) — 위 `DECODE_MAX_DIM` 설명 참고.
 * ② 갤러리·구글포토에서 고른 사진이 기기에 실제로 내려받아져 있지 않다
 *    (`content://` 로만 존재).
 * ③ 확장자만 `.jpg` 이고 속은 다른 형식이다.
 *
 * 그래서 ①에 강한 `createImageBitmap`(디코딩하면서 축소)을 먼저 쓰고,
 * 안 되면 예전 방식(`<img>`), 그래도 안 되면 ②에 강한 `FileReader` 순으로
 * 내려간다. 전부 실패하면 **어느 파일이 왜 안 됐는지**(이름·크기·형식)를
 * 담아 던진다 — 예전에는 "채점에 실패했습니다"만 떠서 원인을 알 수 없었다.
 */
export async function loadDrawableFromFile(file: File): Promise<Drawable> {
  if (file.size === 0) {
    throw new Error(
      `"${file.name}" 사진이 비어 있습니다(0바이트). 클라우드에만 있는 사진일 수 있어요 — 갤러리에서 기기에 내려받은 뒤 다시 골라주세요.`,
    );
  }

  const asBitmap = (bmp: ImageBitmap): Drawable => ({
    src: bmp,
    width: bmp.width,
    height: bmp.height,
    close: () => bmp.close(),
  });
  const asImg = (img: HTMLImageElement): Drawable => ({
    src: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close: () => {},
  });

  // imageOrientation 을 명시해야 세로로 찍은 사진이 눕지 않는다 — 누우면
  // OMR 을 통째로 못 읽는다.
  if (typeof createImageBitmap === "function") {
    try {
      // 먼저 원본 그대로. 작은 사진을 괜히 늘리지 않기 위해서다.
      return asBitmap(await createImageBitmap(file, { imageOrientation: "from-image" }));
    } catch {
      // 원본 크기로는 못 열었다 = 너무 큰 사진이다(갤럭시 카메라 원본 등).
    }
    try {
      // 디코딩하면서 바로 줄인다. resizeWidth 하나만 주면 세로는 비율에
      // 맞춰 따라온다.
      return asBitmap(
        await createImageBitmap(file, {
          imageOrientation: "from-image",
          resizeWidth: DECODE_MAX_DIM,
          resizeQuality: "high",
        }),
      );
    } catch {
      // 다음 방법으로.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    return asImg(await loadImage(objectUrl));
  } catch {
    // 아래 FileReader 로 한 번 더 시도한다.
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  try {
    return asImg(await loadImage(await readAsDataUrl(file)));
  } catch {
    const kb = Math.max(1, Math.round(file.size / 1024));
    throw new Error(
      `"${file.name}" 사진을 열지 못했습니다 (${kb}kB, ${file.type || "형식 불명"}). ` +
        `확장자만 .jpg 이고 실제로는 다른 형식(HEIC 등)일 수 있어요 — 사진을 캡처해서 올리거나 갤러리에서 다시 저장한 뒤 올려주세요.`,
    );
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // onerror의 인자는 Error가 아니라 원시 Event다. 그대로 reject에 넘기면
    // 이 실패가 `err instanceof Error` 로 걸러지는 모든 catch 블록에서
    // 조용히 일반 문구("~에 실패했습니다")로 뭉개진다 — 실제로 가채점
    // 화면에서 HEIC 사진을 골랐을 때 "채점에 실패했습니다"만 뜨고 이유를
    // 알 수 없었다. Error로 감싸 항상 사람이 읽을 문구가 나오게 한다.
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = src;
  });
}
