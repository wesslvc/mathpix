/**
 * 목록에 쓸 작은 미리보기(`.thumb.webp`) 관련 **경로 계산만** 남아 있다.
 *
 * **왜 만들지 않기로 했나** (2026-09-17, 사용자 결정): 이 앱의 실제 트래픽을
 * 재 보니 `/api/card/...` 요청이 하루 열 건 안팎이다 — 원본(700kB~2.3MB)과
 * 썸네일(20~30kB)의 차이가 로딩 속도로 체감될 규모가 애초에 아니었다. 게다가
 * 카드 원본은 이미 R2 로 옮겨 egress 요금 자체가 없다(위 "카드 그림은
 * Cloudflare R2 로 간다" 참고) — 썸네일이 아끼던 것(Supabase egress 5GB/월)이
 * 사라진 뒤라, 남는 이득은 "이 작은 트래픽을 조금 더 작게"뿐이었다.
 *
 * **`thumbPathFor`는 남겨 둔다.** 예전에 만들어진 `.thumb.webp` 파일들이
 * 스토리지에 그대로 있고, `/api/card`의 폴백 로직(썸네일이 없으면 원본을
 * 대신 준다)과 삭제할 때 함께 지우는 자리(`removeBlobs([path,
 * thumbPathFor(path)])`)가 여전히 이 경로 계산에 기대고 있다 — 지우면
 * 옛 파일이 고아로 남는다.
 */

/** 원본 경로에서 미리보기 경로를 만든다. 원본과 늘 같은 자리에 둔다. */
export function thumbPathFor(imagePath: string): string {
  return `${imagePath.replace(/\.png$/i, "")}.thumb.webp`;
}
