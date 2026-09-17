/**
 * 검색·공유에 쓰는 **대표 주소** 한 곳.
 *
 * `siteUrl.ts`(인증 리다이렉트)와 값은 같지만 쓰는 자리가 다르다 — 그쪽은
 * 브라우저에서 "지금 보고 있는 주소"를 섞어 쓰고(로컬 개발 예외), 이쪽은
 * 서버에서 robots·sitemap·OG 에 박는 **고정된 대표 주소**다. 섞으면 미리보기
 * 주소가 sitemap 에 실리는 사고가 난다.
 *
 * 이 파일에는 네트워크 호출이 없다.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "https://reprintocr.vercel.app";
}
