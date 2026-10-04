"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * A lightweight, NON-modal popover anchored under an element — the hand-rolled pattern of
 * `MarginHint`'s CostHistoryPopover, extracted. Portaled to <body> so it escapes a modal's
 * `transform` / `overflow` clipping; `position: fixed` from the anchor rect; closes on an outside
 * mousedown; Escape is a CAPTURE-phase window listener that stops propagation, so a surrounding
 * Radix Dialog (the order builder) does not also close and discard the order.
 *
 * Inside a modal Radix Dialog it portals INTO the dialog's content instead of <body>: outside the
 * content, Radix sets body `pointer-events: none` and traps focus, so a popover on <body> cannot be
 * clicked or focused. The content is `transform`-centred, which makes it the containing block of a
 * `position: fixed` child, so the viewport coordinates are shifted by the content's own rect.
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
  /** Why it closed: Escape or a mousedown outside (the panel's own actions call their own close). */
  onClose: (reason?: "escape" | "outside") => void;
  label: string;
  /** Card width in px (kept on screen horizontally). */
  width?: number;
  /** Extra key handling inside the panel (arrows / Enter); Escape is handled here. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const host = React.useMemo(
    () => anchor.closest<HTMLElement>('[role="dialog"]') ?? document.body,
    [anchor],
  );
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
      // `position: fixed` resolves against a transformed host, not the viewport.
      const o = host === document.body ? { top: 0, left: 0 } : host.getBoundingClientRect();
      setPos({ top: top - o.top, left: left - o.left });
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ref.current) ro?.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, width, host]);

  // Focus once the panel is measured and VISIBLE: a browser ignores focus() on a
  // `visibility: hidden` element, so focusing at mount left focus on the trigger (Tab then went to
  // the chips row, never the popover's actions).
  const placed = pos !== null;
  React.useEffect(() => {
    if (placed) ref.current?.focus({ preventScroll: true });
  }, [placed]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !anchor.contains(t)) onClose("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose("escape");
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
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "70vh",
        overflowY: "auto",
      }}
      className="z-[300] rounded-lg border border-surface-border bg-white p-3 shadow-modal outline-none ph-pop"
    >
      {/* Quick fade-in; skipped for reduced motion. (Local style: app/globals.css is byte-pinned.) */}
      <style>
        {
          "@media (prefers-reduced-motion: no-preference){.ph-pop{animation:ph-fade 120ms ease-out}}@keyframes ph-fade{from{opacity:0}to{opacity:1}}"
        }
      </style>
      {children}
    </div>,
    host,
  );
}
