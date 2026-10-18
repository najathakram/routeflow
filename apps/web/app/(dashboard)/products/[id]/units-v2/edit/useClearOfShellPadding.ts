"use client";

import * as React from "react";

/**
 * F22 / K11-16: the dashboard's `#main-content` is the scroller and has pb-24, and a sticky element stops at its
 * scroller's padding, so left alone it floats 96px up. The `bottom` to give a sticky element so it rests at the real
 * bottom: the shell's computed bottom padding, negated (0 when there is no shell or no padding). Read with Number():
 * the edit folder's guard spec keeps float parsers out. Shared by `PriceEditBar` (which also measures itself for
 * scroll-padding) and the saved line that takes the bar's slot, so the two can never disagree.
 */
export function useShellBottom(active: boolean): number {
  const [inset, setInset] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const main = document.getElementById("main-content");
    if (!main) {
      setInset(0);
      return;
    }
    const padding = Number(getComputedStyle(main).paddingBottom.replace("px", ""));
    setInset(Number.isFinite(padding) ? padding : 0);
  }, [active]);
  return inset === 0 ? 0 : -inset;
}
