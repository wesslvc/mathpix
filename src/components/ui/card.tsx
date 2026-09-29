import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 판 모양의 클래스 — `<section>`·`<form>`·`<Link>` 처럼 `<div>` 가 아닌 태그에
 * 같은 모양을 입힐 때 `cn(cardClass, "…")` 로 쓴다.
 */
const cardClass =
  "rounded-[16px] border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)]";

/** 판 — 화면의 덩어리 하나(예전 `g-panel`). 그림자는 거의 안 보이게. */
const Card = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardClass, className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export { Card, cardClass };
