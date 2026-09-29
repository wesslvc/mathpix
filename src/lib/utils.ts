import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * className 을 합친다 — shadcn/ui 의 표준 `cn`.
 *
 * `twMerge` 가 **충돌하는 유틸리티를 뒤에 온 것으로 갈아 끼운다**
 * (`px-4` + `px-2` → `px-2`). 예전 `g-btn` 계열은 이걸 `@layer components`
 * 순서에 기대서 풀었는데, 컴포넌트 안에서 합치면 그 순서 걱정이 없다.
 *
 * tailwind-merge 는 **2.x** 여야 한다 — 3.x 는 Tailwind v4 의 클래스 이름을
 * 기준으로 하고 이 저장소는 v3.4 라, 3.x 를 쓰면 `shadow-sm`·`rounded` 같은
 * 단계 이름을 잘못 병합한다.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
