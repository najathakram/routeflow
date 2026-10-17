"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/** Bars currently mounted; <body data-edit-bar> stays set until the last one unmounts. */
let mounted = 0;

/**
 * O2 (F11, apple-ux run 2026-10-16): the edit-mode Save / Cancel row sticks to the bottom of the
 * viewport while the Line Items card is on screen, so Save is reached with no scroll at any
 * width. One bar: the page's former bottom row moved here, nothing duplicated. The bottom padding
 * keeps it above a phone's home indicator.
 *
 * Dock: the dashboard's <main id="main-content"> has pb-24 (room for the fixed install prompt) and
 * Chrome insets a sticky edge by the scroll container's padding, so `bottom-0` floated the bar
 * ~96px up the screen. `-bottom-24` cancels that padding (keep the two in step with layout.tsx).
 * The fixed PwaInstallPrompt would then sit on top of Save, so while a bar is mounted it sets
 * <body data-edit-bar> and the prompt hides itself (`[body[data-edit-bar]_&]:hidden`) - the
 * prompt yields rather than the bar lifting, so Save never moves.
 */
export function StickyEditBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  React.useEffect(() => {
    mounted += 1;
    document.body.setAttribute("data-edit-bar", "");
    return () => {
      mounted -= 1;
      if (mounted <= 0) document.body.removeAttribute("data-edit-bar");
    };
  }, []);
  return (
    <div
      data-testid="edit-save-bar"
      className={cn(
        "sticky -bottom-24 z-20 -mx-6 -mb-6 flex flex-wrap items-center gap-2 rounded-b-lg border-t border-surface-border bg-white/95 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}
