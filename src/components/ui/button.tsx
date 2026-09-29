import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * 버튼 — shadcn/ui `Button`. 모양은 예전 `g-btn` 계열과 **같은 값**이다
 * (화면이 바뀐 것처럼 보이면 안 된다).
 *
 * - 호버는 `[&:not(:disabled)]:hover:` 로 쓴다. `enabled:hover:` 는 `<a>`
 *   (링크 버튼)에 안 붙는다 — `:enabled` 는 폼 요소에만 있는 가상 클래스다.
 * - `variant="text"` 의 패딩은 size 와 상관없이 이긴다(예전 `g-btn-text` 도
 *   그랬다) — `compoundVariants` 가 size 뒤에 온다.
 * - `type` 을 자동으로 채우지 않는다. 예전 `<button className="g-btn …">` 도
 *   안 채웠고, 폼 안의 버튼이 제출을 일으키는지는 부르는 쪽이 정한다.
 */
const buttonVariantsBase = cva(
  [
    "inline-flex items-center justify-center gap-[0.4rem] whitespace-nowrap",
    "rounded-[10px] border border-transparent px-4 py-2",
    "text-[0.875rem] font-semibold leading-5",
    "transition-[background-color,box-shadow,border-color,color,transform] duration-150",
    "[-webkit-tap-highlight-color:transparent]",
    "[&:not(:disabled)]:active:scale-[0.98]",
    "disabled:cursor-not-allowed disabled:opacity-45",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
  ],
  {
    variants: {
      variant: {
        // 색을 안 주는 바탕 — 부르는 쪽이 className 으로 색을 정한다.
        plain: "",
        primary: [
          "bg-primary text-primary-foreground",
          "shadow-[0_1px_2px_rgba(16,40,72,0.18),inset_0_1px_0_rgba(255,255,255,0.14)]",
          "[&:not(:disabled)]:hover:bg-[var(--g-blue-hover)]",
        ],
        outline: [
          "border-border bg-card text-[#3a3f47]",
          "shadow-[0_1px_2px_rgba(16,24,40,0.04)]",
          "[&:not(:disabled)]:hover:border-[#cbd2db] [&:not(:disabled)]:hover:bg-[#f8f9fb] [&:not(:disabled)]:hover:text-foreground",
        ],
        // 옅은 파랑 — 두 번째로 중요한 동작(예: AI 로 다시 그리기).
        soft: "bg-accent text-accent-foreground [&:not(:disabled)]:hover:bg-[#dbe8f6]",
        // 글자만 — 닫기·건너뛰기처럼 가벼운 동작.
        ghost:
          "bg-transparent text-[#4e545d] [&:not(:disabled)]:hover:bg-secondary [&:not(:disabled)]:hover:text-foreground",
        dark: "bg-foreground text-white [&:not(:disabled)]:hover:bg-[#272b31]",
        text: "text-primary [&:not(:disabled)]:hover:bg-secondary",
      },
      size: {
        default: "",
        // `leading-5` 를 크기마다 다시 적는다 — tailwind-merge 는 `text-[…]` 크기
        // 클래스가 오면 앞의 `leading-*` 를 **지운다**(둘을 충돌로 본다). 안 적으면
        // 작은 버튼의 줄 높이가 글자 크기의 1.5배로 떨어져 예전보다 낮아진다.
        sm: "rounded-[9px] px-3 py-[0.35rem] text-[0.8125rem] leading-5",
        xs: "rounded-[8px] px-[0.55rem] py-[0.2rem] text-[0.75rem] leading-5",
      },
    },
    compoundVariants: [
      { variant: "text", className: "px-[0.7rem] py-[0.4rem]" },
    ],
    defaultVariants: { variant: "plain", size: "default" },
  },
);

/**
 * 버튼 모양의 className. `<Link>`·`<a>` 를 버튼처럼 보이게 할 때 쓴다.
 * **병합해서 돌려준다** — cva 는 클래스를 이어 붙이기만 해서, 그대로 쓰면
 * 바탕의 `border-transparent` 와 변형의 `border-border` 가 둘 다 남고 CSS 에서
 * 뒤에 생성된 쪽(투명)이 이긴다(링크 버튼 테두리가 사라졌다).
 */
function buttonVariants(
  props?: Parameters<typeof buttonVariantsBase>[0],
): string {
  return cn(buttonVariantsBase(props));
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariantsBase> {
  /** true 면 자식 요소(예: `next/link` 의 `<Link>`)가 버튼 모양을 입는다. */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={buttonVariants({ variant, size, className })}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
