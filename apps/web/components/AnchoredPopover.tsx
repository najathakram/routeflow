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
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  label: string;
  /** Card width in px (kept on screen horizontally). */
  width?: number;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(width, window.innerWidth - 16);
    const left = Math.min(r.left, window.innerWidth - w - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left) });
  }, [anchor, width]);

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

  if (pos == null) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: Math.min(width, window.innerWidth - 16),
        maxHeight: "70vh",
        overflowY: "auto",
      }}
      className="z-[300] rounded-lg border border-surface-border bg-white p-3 shadow-modal"
    >
      {children}
    </div>,
    document.body,
  );
}
