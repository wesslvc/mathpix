import * as React from "react";

import { cn } from "@/lib/utils";

/** 작은 꼬리표(점수·상태 등, 예전 `g-chip`). */
function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-secondary px-[0.55rem] py-[0.1rem] text-[0.72rem] font-semibold leading-[1.2rem] text-[#4e545d]",
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
