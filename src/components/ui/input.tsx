import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 입력칸 모양 — 예전 `g-input` 과 같은 값. `<input>`·`<textarea>`·`<select>`
 * 가 **같은 모양**이어야 해서 클래스 문자열을 한 곳에 두고 셋이 나눠 쓴다.
 *
 * 포커스는 파랑 테두리 + 옅은 고리이고 윤곽선은 없다. 예전 CSS 는
 * `:focus-visible` 에 윤곽선을 적어 놓고 바로 뒤 `:focus` 에서 `outline:none`
 * 으로 덮었으니 실제로 보이던 것은 이쪽이다.
 */
const inputClass =
  "rounded-[10px] border border-border bg-card px-[0.8rem] py-[0.55rem] text-[0.875rem] transition-[border-color,box-shadow] duration-150 focus:border-primary focus:shadow-[0_0_0_3px_rgba(47,116,184,0.15)] focus:outline-none";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(inputClass, className)} {...props} />
  ),
);
Input.displayName = "Input";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(inputClass, className)} {...props} />
));
Textarea.displayName = "Textarea";

/** 브라우저 기본 `<select>` — 모바일에서는 OS 의 고르기 창이 떠서 그쪽이 낫다. */
const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(inputClass, className)} {...props} />
));
NativeSelect.displayName = "NativeSelect";

export { Input, Textarea, NativeSelect, inputClass };
