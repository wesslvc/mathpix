import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 목록에 쓸 **작은 미리보기**를 만들어 원본 옆에 같이 올린다.
 *
 * 왜 필요한가: 저장되는 카드 PNG 는 평균 760kB, 큰 것은 2.3MB 다(폭 640 카드를
 * `pixelRatio: 2` 로 찍으니 1280px 짜리다). 그런데 실모 상세의 **목록 보기는
 * 그걸 56×40px 로 보여준다.** 화면에 그릴 크기의 스무 배가 넘는 픽셀을 매번
 * 내려받고 있었던 것이다. 20문제짜리 실모를 한 번 여는 데 15MB 다.
 *
 * 게다가 서명 URL 은 화면을 열 때마다 새로 만들어져 주소가 달라진다 —
 * **브라우저 캐시가 한 번도 안 걸린다.** 들어갈 때마다 전부 다시 받는다.
 *
 * 그래서 원본은 그대로 두고(인쇄와 수정에는 원본이 필요하다) 목록용으로
 * 폭 320px WebP 를 하나 더 올린다. 보통 15~30kB 라 저장 용량에는 거의 영향이
 * 없고, 목록 트래픽은 40분의 1 아래로 떨어진다.
 */

/** 목록 미리보기의 폭(px). 카드 보기가 한 칸에 320px 안쪽으로 그려진다. */
const THUMB_WIDTH = 320;
/** WebP 품질. 글자가 읽히기만 하면 되는 미리보기라 넉넉히 낮춰도 된다. */
const THUMB_QUALITY = 0.8;

/** 원본 경로에서 미리보기 경로를 만든다. 원본과 늘 같은 자리에 둔다. */
export function thumbPathFor(imagePath: string): string {
  return `${imagePath.replace(/\.png$/i, "")}.thumb.webp`;
}

/**
 * 이미지를 폭 `THUMB_WIDTH` 로 줄여 WebP 로 만든다.
 *
 * 실패하면 `null` 이다 — 미리보기가 없으면 원본을 쓰면 그만이라(예전과 같은
 * 동작) 이것 때문에 저장을 막을 이유가 없다.
 */
export async function makeThumbBlob(
  source: ThumbSource,
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  try {
    const img = await loadImage(source);
    if (!img.naturalWidth || !img.naturalHeight) return null;

    // 이미 충분히 작으면 만들지 않는다(똑같은 것을 하나 더 두는 셈이다).
    if (img.naturalWidth <= THUMB_WIDTH) return null;

    const scale = THUMB_WIDTH / img.naturalWidth;
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 카드는 흰 바탕이다. 투명 배경으로 두면 어두운 화면에서 글자가 묻힌다.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", THUMB_QUALITY),
    );
    // WebP 를 못 만드는 브라우저면 null 이 온다. 그때도 원본으로 돌아가면 된다.
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/** 이미 화면에 있는 `<img>`, 방금 만든 Blob, 또는 주소 무엇이든 받는다. */
export type ThumbSource = string | Blob | HTMLImageElement;

async function loadImage(source: ThumbSource): Promise<HTMLImageElement> {
  if (typeof source !== "string" && !(source instanceof Blob)) return source;

  // Blob 은 임시 주소를 만들어 읽고 **반드시 되돌려준다** — 안 그러면 문제를
  // 저장할 때마다 수백 kB 짜리가 탭이 닫힐 때까지 메모리에 남는다.
  const objectUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
  const url = objectUrl ?? (source as string);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      // 서명 URL 은 다른 출처다. 이걸 안 주면 canvas 가 오염돼 `toBlob` 이 던진다.
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
      img.src = url;
    });
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 미리보기를 만들어 원본 옆에 올린다.
 *
 * **있는지 없는지를 따로 적어 둘 필요는 없다.** 목록은 원본과 미리보기 주소를
 * 한 번에 서명하는데(`createSignedUrls`), 없는 파일에는 오류를 돌려주므로 그
 * 자리에서 알 수 있다. DB 에 플래그를 두면 이미지를 새 경로에 다시 올릴 때마다
 * 같이 고쳐야 하고(그런 자리가 넷이다) 한 곳이라도 빠지면 목록에 깨진 그림이
 * 뜬다 — 안 두는 편이 안전하다.
 *
 * 실패는 삼킨다. 미리보기가 없으면 목록이 원본을 쓸 뿐이라(예전 그대로) 이
 * 때문에 저장이 실패하면 안 된다.
 */
export async function uploadThumb(
  supabase: SupabaseClient,
  imagePath: string,
  source: ThumbSource,
): Promise<boolean> {
  const blob = await makeThumbBlob(source);
  if (!blob) return false;
  const { error } = await supabase.storage
    .from("problem-images")
    // **덮어쓰기(upsert)는 쓰지 않는다.** 이 버킷에는 UPDATE 정책이 없어서
    // RLS 에 막힌다(원본을 새 경로에 올리고 예전 것을 지우는 이유가 그것이다).
    // 미리보기 경로는 원본 경로에서 나오고 원본은 늘 새 UUID 라, 여기 올 때
    // 그 자리는 언제나 비어 있다.
    .upload(thumbPathFor(imagePath), blob, { contentType: "image/webp" });
  return !error;
}
