import * as React from "react";

/**
 * K11-16: keep an `overflow-hidden` shell wrapper at scroll 0,0.
 *
 * `overflow: hidden` only hides the scrollbar; scrollIntoView, focus and a native click that scrolls its target into
 * view can still scroll the box (at 1440 a mouse Save moved the dashboard's right column by the header's 64 px).
 * `overflow: clip` would forbid that but regressed small screens, so instead any scroll the wrapper takes is undone.
 * The page's own scroller (`#main-content`) is a child and is untouched.
 */
export function useNoShellScroll(ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reset = () => {
      if (el.scrollTop !== 0) el.scrollTop = 0;
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
    };
    el.addEventListener("scroll", reset, { passive: true });
    return () => el.removeEventListener("scroll", reset);
  }, [ref]);
}
