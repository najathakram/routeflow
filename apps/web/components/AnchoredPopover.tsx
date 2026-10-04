"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * A lightweight, NON-modal popover anchored under an element — the hand-rolled pattern of
 * `MarginHint`'s CostHistoryPopover, extracted. Portaled to <body> so it escapes a modal's
 * `transform` / `overflow` clipping; `position: fixed` from the anchor rect; closes on an outside
 * mousedown; Escape is a CAPTURE-phase window listener that stops propagation, so a surrounding
 * Radix Dialog (the order builder) does not also close and discard the order.
 */
export function AnchoredPopover({
  anchor,
  onClose,
  label,
  width = 360,
  onKeyDown,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  label: string;
  /** Card width in px (kept on screen horizontally). */
  width?: number;
  /** Extra key handling inside the panel (arrows / Enter); Escape is handled here. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  // Anchor under the element; flip ABOVE when there is no room below (and more room above), and
  // always clamp inside the viewport. Measured after render so the real height is used.
  React.useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = Math.min(width, window.innerWidth - 16);
      const h = ref.current?.offsetHeight ?? 0;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const flip = h > below && above > below;
      const top = flip ? Math.max(8, r.top - 4 - Math.min(h, above)) : r.bottom + 4;
      setPos({ top, left });
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ref.current) ro?.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, width]);

  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
        width: Math.min(width, window.innerWidth - 16),
        maxHeight: "70vh",
        overflowY: "auto",
      }}
      className="z-[300] rounded-lg border border-surface-border bg-white p-3 shadow-modal outline-none motion-safe:animate-[ph-fade_120ms_ease-out]"
    >
      {children}
    </div>,
    document.body,
  );
}
