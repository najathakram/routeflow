"use client";

import * as React from "react";

/**
 * SA-1071 K2: true while `el` is NOT on screen. `bottomInset` is the height of a bar floating over the bottom of the screen: what
 * sits behind it counts as off screen. Until the browser has answered (and where there is no IntersectionObserver) it is true, so
 * whatever this guards is drawn exactly as it was before. One observer, dropped on unmount.
 */
export function useElementOffScreen(el: Element | null, bottomInset = 0): boolean {
  const [off, setOff] = React.useState(true);
  React.useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") {
      setOff(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setOff(!last.isIntersecting);
      },
      { rootMargin: `0px 0px -${Math.max(0, Math.round(bottomInset))}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, bottomInset]);
  return off;
}
