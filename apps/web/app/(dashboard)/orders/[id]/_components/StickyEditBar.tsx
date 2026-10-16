import * as React from "react";
import { cn } from "@routeflow/ui/web";

/**
 * O2 (F11, apple-ux run 2026-10-16): the edit-mode Save / Cancel row sticks to the bottom of the
 * viewport while the Line Items card is on screen, so Save is reached with no scroll at any
 * width. One bar: the page's former bottom row moved here, nothing duplicated. The bottom padding
 * keeps it above a phone's home indicator.
 */
export function StickyEditBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="edit-save-bar"
      className={cn(
        "sticky bottom-0 z-20 -mx-6 -mb-6 flex flex-wrap items-center gap-2 rounded-b-lg border-t border-surface-border bg-white/95 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}
