import * as React from "react";

/**
 * Height of a fixed bottom bar, kept current by a ResizeObserver (the pattern the counter uses for
 * `--counter-main-pb`). The page turns it into bottom padding, so a bar that wraps to several rows at
 * phone width never covers the last form control. Returns `[height, callbackRef]`.
 */
export function useBarHeight(): [number, (el: HTMLElement | null) => void] {
  const [height, setHeight] = React.useState(0);
  const observer = React.useRef<ResizeObserver | null>(null);
  const ref = React.useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  return [height, ref];
}
