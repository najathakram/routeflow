"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { guardCounterLeave } from "./counter-cart-signal";

/** `useRouter()` whose push is refused while a counter sale is being recorded and asks "Discard this sale?" when the cart has lines (see guardCounterLeave). replace/back are untouched. */
export function useGuardedRouter() {
  const router = useRouter();
  return React.useMemo(
    () => ({
      ...router,
      push: (...args: Parameters<typeof router.push>) => {
        if (guardCounterLeave(() => router.push(...args))) return;
        router.push(...args);
      },
    }),
    [router],
  );
}
