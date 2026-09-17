/**
 * AI 가 그림을 갈아치울 때 **직전 그림을 `origin` 으로 옮겨 두는 규칙 한 곳.**
 *
 * 이 규칙은 원래 **네 자리**에 똑같이 적혀 있었다(`FigureJobsProvider` ·
 * `ProblemGallery` · `ResultStage` · 서버의 `persistWholeProblem`). 네 벌이면
 * 반드시 한쪽만 고쳐진다 — 실제로 서버 쪽이 빠져서 탭을 닫고 돌아온 문제에만
 * 원본이 없어진 적이 있다. 그래서 한 곳으로 모았다.
 *
 * 두 가지를 지킨다:
 *
 * ① **한 번 담기면 덮지 않는다.** 두 번째 AI 결과가 첫 번째 AI 결과를 원본으로
 *    만들어 버리면 안 된다 — 원본은 언제나 사람이 오려낸 그 그림이다.
 * ② **담은 때를 함께 적는다**(`originAt`). 원본은 "되돌리기"를 위한 보험인데
 *    문제 하나당 평균 1MB 로 **DB 의 절반**을 차지하고 있었다(2026-09-16 실측:
 *    origin 123MB / DB 264MB). 사용자가 정한 방침은 "AI 결과가 마음에 들면
 *    버리기" — 만든 지 오래된 원본은 `expire_figure_origins()` 가 밤마다
 *    지운다(마이그레이션 `0024`). 그 판정에 이 시각이 쓰인다.
 *
 * **이 파일에는 네트워크 호출도 환경변수도 없다** — 화면과 서버가 같은 판정을
 * 써야 한다(`problemBoxes.ts`·`gradeSummary.ts` 와 같은 이유).
 */

/** `origin` 을 담을 수 있는 최소 모양. 화면·서버의 그림 객체가 모두 이 꼴이다. */
type HasOrigin = {
  origin?: unknown;
  originAt?: unknown;
};

/**
 * `previous`(지금 붙어 있는 그림)를 원본 자리로 옮긴 사본을 돌려준다.
 *
 * 이미 원본이 있거나 옮길 것이 없으면 **아무것도 안 바꾼 사본**이다.
 */
export function keepOrigin<T extends HasOrigin>(figure: T, previous: unknown): T {
  if (typeof figure.origin === "string") return { ...figure };
  if (typeof previous !== "string" || previous.length === 0) return { ...figure };
  return { ...figure, origin: previous, originAt: new Date().toISOString() };
}
