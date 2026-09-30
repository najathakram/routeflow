import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import * as React from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Minimum 44×44 CSS-pixel hit area for icon-only interactive controls (WCAG
 * 2.5.5 / iOS HIG), on all viewports — not just mobile breakpoints. Compose
 * with `cn()` at the call site: `cn(TAP_TARGET, "h-5 w-5 ...")`. Where the
 * control must stay visually smaller than 44px, this grows the hit area via
 * padding/centering rather than the icon itself — the icon's own size
 * classes are unaffected.
 */
export const TAP_TARGET = "min-h-[44px] min-w-[44px] inline-flex items-center justify-center";

/** Merge multiple React refs into one callback ref. */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(node);
      } else {
        (ref as { current: T | null }).current = node;
      }
    }
  };
}
