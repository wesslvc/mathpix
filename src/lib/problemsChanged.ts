/**
 * **문제 행이 화면 밖에서 바뀌었다는 알림.** 서버 일꾼이 그림을 저장했거나(문제 통째로 그리기·지문 인식), 대기열이
 * 그림 하나를 카드에 반영했을 때 `FigureJobsProvider` 가 쏜다. 열려 있는 목록(`ProblemGallery`)이 받아 서버 목록을
 * 다시 받는다 — 안 그러면 새로고침하기 전까지 옛 그림이 보인다.
 */
export const PROBLEMS_CHANGED_EVENT = "problems:changed";

export function announceProblemsChanged(problemIds: string[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROBLEMS_CHANGED_EVENT, { detail: { problemIds } }));
}
