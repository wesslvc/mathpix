/**
 * 저장된 카드 그림의 주소. **경로 하나당 주소 하나로 고정이다.**
 *
 * 왜 서명 URL 을 안 쓰는지는 `src/app/api/card/[...path]/route.ts` 주석에
 * 적어 두었다 — 한 줄로 줄이면, 서명 URL 은 부를 때마다 주소가 달라져
 * **브라우저 캐시가 한 번도 안 걸리고** 그게 Supabase egress 의 대부분이었다.
 *
 * **작은 미리보기(`cardThumbUrl`)는 없앴다**(2026-09-17). 실제 트래픽을
 * 재 보니 `/api/card/...` 요청이 하루 열 건 안팎이라, 원본과 썸네일의 차이가
 * 체감될 규모가 아니었다(`cardThumb.ts` 참고). 목록·카드는 이제 이 함수
 * 하나만 쓴다.
 *
 * 이 파일에는 네트워크 호출도 환경변수도 없다(`problemBoxes.ts`·
 * `gradeSummary.ts` 와 같은 이유 — 서버와 화면이 같은 주소를 만들어야 한다).
 */
export function cardUrl(imagePath: string): string {
  return `/api/card/${imagePath}`;
}
