/**
 * **그림이 이 스토리지 경로를 가리키는가.** 순수 함수 — 서버·브라우저가 함께 쓴다.
 *
 * 통째로 다시 그린 문제는 그림의 마크업이 곧 카드 파일(`image_path`)이다(`persistWholeProblem` 이 바이트를 두 번
 * 안 올리려고 그렇게 한다). 그래서 "카드를 새로 저장하고 옛 카드를 지운다"를 그대로 하면 **그 그림이 빈다** —
 * 실제로 수정 창에서 저장한 뒤 그림이 지워진 파일을 가리키는 행이 있었다(2026-10-02). 옛 카드를 지우는 자리마다
 * 이걸로 먼저 확인한다. 조판 전 상태(`box_range.preTypeset`)의 그림도 함께 넘긴다.
 */
export function figuresReference(path: string, figures: unknown[]): boolean {
  if (!path) return false;
  return figures.some((f) => {
    if (!f || typeof f !== "object") return false;
    const o = f as { markup?: unknown; origin?: unknown };
    return [o.markup, o.origin].some((v) => typeof v === "string" && v.includes(path));
  });
}

/** box_range 에서 카드 파일을 가리킬 수 있는 그림을 모두 꺼낸다(지금 그림 + 조판 전 그림). */
export function figuresOfBox(box: unknown, current?: unknown[]): unknown[] {
  const b = (box && typeof box === "object" ? box : {}) as { figures?: unknown; preTypeset?: { figures?: unknown } };
  const now = current ?? (Array.isArray(b.figures) ? b.figures : []);
  const pre = Array.isArray(b.preTypeset?.figures) ? b.preTypeset.figures : [];
  return [...now, ...pre];
}
