"use client";

import * as React from "react";
import { cn } from "./utils";

export interface StickyFooterProps {
  children: React.ReactNode;
  /** Frosted glass behind the footer (solid where `backdrop-filter` is unsupported). Default true. */
  frosted?: boolean;
  className?: string;
}

/**
 * Pins to the bottom of its scroll container, clear of the home indicator. `scroll-mb` on the
 * footer keeps a focused input in the scroll area from sliding underneath it.
 */
export function StickyFooter({ children, frosted = true, className }: StickyFooterProps) {
  return (
    <div
      data-sticky-footer=""
      className={cn(
        "sticky bottom-0 z-10 border-t border-surface-border px-3 pt-3",
        "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
        // Solid by default; the frosted look only where the browser can blur.
        "bg-white",
        frosted &&
          "supports-[backdrop-filter]:bg-white/80 supports-[backdrop-filter]:backdrop-blur-md",
        className,
      )}
    >
      {children}
    </div>
  );
}
