"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@routeflow/ui/web";

/**
 * The ONE popover for dropdown lists (Unit / Category / product pickers). It renders through a
 * body portal with `position: fixed`, placed from the anchor's rect, so a scroll container or a
 * transformed Radix dialog can neither clip nor cover it. Opens below the anchor, flips above when
 * there is not room, clamps its height to the viewport and follows scroll / resize.
 *
 * `pointer-events-auto` is load-bearing: Radix sets `pointer-events: none` on <body> while a modal
 * is open. Outside-click handlers must treat the list as inside — see {@link isInsideAnchoredList}.
 */
const LIST_ATTR = "data-anchored-list";
const GAP = 2;
const EDGE = 8;

export function isInsideAnchoredList(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${LIST_ATTR}]`) !== null;
}

interface Placement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function AnchoredList({
  anchorRef,
  open,
  maxHeight = 192,
  className,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  /** Preferred maximum height in px; clamped to the room actually available. */
  maxHeight?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const [place, setPlace] = React.useState<Placement | null>(null);

  const measure = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const flip = below < Math.min(maxHeight, 160) && above > below;
    const room = Math.max(flip ? above : below, 80);
    setPlace({
      left: r.left,
      width: r.width,
      maxHeight: Math.min(maxHeight, room),
      ...(flip ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [anchorRef, maxHeight]);

  React.useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    // capture: scrolls of any ancestor (the dialog body) reposition the list
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  if (!open || !place || typeof document === "undefined") return null;

  return createPortal(
    <div
      {...{ [LIST_ATTR]: "" }}
      className={cn(
        "pointer-events-auto overflow-y-auto rounded-lg border border-surface-border bg-white shadow-dropdown",
        className,
      )}
      style={{
        position: "fixed",
        zIndex: 300,
        left: place.left,
        width: place.width,
        top: place.top,
        bottom: place.bottom,
        maxHeight: place.maxHeight,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
