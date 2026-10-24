"use client";

import * as React from "react";
import { cn } from "./utils";

export interface ScrollShadowProps {
  /** Classes for the outer (relative) box: border, radius, background, negative margins. */
  className?: string;
  /** Classes for the inner scroller; `overflow-x-auto` is always applied. */
  scrollerClassName?: string;
  /** Accessible name of the scroller while it overflows (it becomes a focusable region). */
  scrollLabel?: string;
  /** Extra props for the scroller element (data-*, aria-*, ref-free). */
  scrollerProps?: React.HTMLAttributes<HTMLDivElement>;
  children: React.ReactNode;
}

const EDGE = 2; // px of tolerance for sub-pixel scroll positions

/**
 * The shared horizontal scroll wrapper. A wide table at 390px used to be cut off with no cue that it scrolls;
 * this shows a soft right-edge fade while there is more to the right and a left fade once scrolled, and no
 * fade when everything fits. The fades are decorative (aria-hidden, pointer-events-none).
 */
export function ScrollShadow({
  className,
  scrollerClassName,
  scrollLabel,
  scrollerProps,
  children,
}: ScrollShadowProps) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false, overflows: false });

  const measure = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > EDGE;
    const overflows = max > EDGE;
    const right = overflows && el.scrollLeft < max - EDGE;
    setEdges((prev) =>
      prev.left === left && prev.right === right && prev.overflows === overflows
        ? prev
        : { left, right, overflows },
    );
  }, []);

  React.useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  const { onScroll, className: extraClass, ...rest } = scrollerProps ?? {};

  return (
    <div className={cn("relative", className)}>
      <div
        {...rest}
        // A scrollable region must be reachable and named for keyboard / screen-reader users, but only
        // while it actually overflows (otherwise it would be a pointless tab stop).
        {...(edges.overflows
          ? { tabIndex: 0, role: "region", "aria-label": scrollLabel ?? "Scrollable content" }
          : {})}
        ref={scrollerRef}
        className={cn("overflow-x-auto", scrollerClassName, extraClass)}
        onScroll={(e) => {
          measure();
          onScroll?.(e);
        }}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        data-scroll-hint="left"
        data-visible={edges.left ? "true" : "false"}
        className="pointer-events-none absolute inset-y-0 left-0 w-8 rounded-[inherit] bg-gradient-to-r from-navy/15 to-transparent opacity-0 transition-opacity data-[visible=true]:opacity-100"
      />
      <div
        aria-hidden="true"
        data-scroll-hint="right"
        data-visible={edges.right ? "true" : "false"}
        className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-[inherit] bg-gradient-to-l from-navy/15 to-transparent opacity-0 transition-opacity data-[visible=true]:opacity-100"
      />
    </div>
  );
}
