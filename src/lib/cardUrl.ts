import { thumbPathFor } from "./cardThumb";

/**
 * 저장된 카드 그림의 주소. **경로 하나당 주소 하나로 고정이다.**
 *
 * 왜 서명 URL 을 안 쓰는지는 `src/app/api/card/[...path]/route.ts` 주석에
 * 적어 두었다 — 한 줄로 줄이면, 서명 URL 은 부를 때마다 주소가 달라져
 * **브라우저 캐시가 한 번도 안 걸리고** 그게 Supabase egress 의 대부분이었다.
 *
 * 이 파일에는 네트워크 호출도 환경변수도 없다(`problemBoxes.ts`·
 * `gradeSummary.ts` 와 같은 이유 — 서버와 화면이 같은 주소를 만들어야 한다).
 */
export function cardUrl(imagePath: string): string {
  return `/api/card/${imagePath}`;
}

/**
 * 목록에 쓸 작은 그림의 주소.
 *
 * **있는지 없는지 미리 확인하지 않는다.** 옛 문제에는 미리보기가 없는데,
 * 라우트가 없으면 원본을 대신 내주므로 화면은 늘 이 주소만 적으면 된다
 * (예전에는 목록을 열 때마다 존재 확인 겸 서명을 한 번 더 했다).
 */
export function cardThumbUrl(imagePath: string): string {
  return cardUrl(thumbPathFor(imagePath));
}
