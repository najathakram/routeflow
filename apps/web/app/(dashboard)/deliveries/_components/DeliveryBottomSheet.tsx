"use client";

import * as React from "react";
import { Loader2, MoreVertical } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useReducedMotion } from "./useReducedMotion";

export type SheetDetent = "peek" | "half" | "full";

const DETENT_ORDER: SheetDetent[] = ["peek", "half", "full"];
const PEEK_PX = 132;
const HALF_RATIO = 0.55;
const FULL_RATIO = 0.9;
const FLING_VELOCITY = 0.55; // px/ms — a quick flick snaps a whole detent further
const TAP_SLOP = 6; // px of movement below which a pointer gesture counts as a tap

const DETENT_LABEL: Record<SheetDetent, string> = {
  peek: "collapsed",
  half: "half expanded",
  full: "fully expanded",
};

function nextDetent(current: SheetDetent): SheetDetent {
  const idx = DETENT_ORDER.indexOf(current);
  return DETENT_ORDER[(idx + 1) % DETENT_ORDER.length];
}

function useViewportHeight(): number {
  const [vh, setVh] = React.useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  React.useEffect(() => {
    function update() {
      setVh(window.innerHeight);
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return vh;
}

export interface DeliverySheetOverflowAction {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Keep the menu open after this item fires (e.g. a "Discard" item that
   *  swaps itself for a "Yes, discard / Cancel" confirm pair in place). */
  keepOpen?: boolean;
}

export interface DeliveryBottomSheetProps {
  detent: SheetDetent;
  onDetentChange: (next: SheetDetent) => void;
  /** "N stops · N orders" — shown next to the drag handle at every detent. */
  summary: string;
  primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
  };
  overflow?: DeliverySheetOverflowAction[];
  /** Scrollable body — the caller decides what belongs in it per detent. */
  children: React.ReactNode;
  className?: string;
}

/**
 * Hand-rolled, non-modal bottom sheet for `/deliveries/new` below `lg`
 * (owner-requested phone UX, 2026-09-17). Three detents — peek (~132px),
 * half (55vh, default), full (90vh) — driven by pixel heights derived from
 * the viewport. Dragging only ever animates `transform: translate3d`, never
 * `height` (owner directive). Not a dialog: no focus trap, no backdrop — the
 * map behind it stays fully interactive at every detent.
 */
export function DeliveryBottomSheet({
  detent,
  onDetentChange,
  summary,
  primary,
  overflow,
  children,
  className,
}: DeliveryBottomSheetProps) {
  const reducedMotion = useReducedMotion();
  const vh = useViewportHeight();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [dragOffset, setDragOffset] = React.useState(0);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const wasDragRef = React.useRef(false);
  const dragRef = React.useRef<{
    startY: number;
    startTime: number;
    lastY: number;
    lastTime: number;
  } | null>(null);
  const contentDragRef = React.useRef<{
    startY: number;
    startScrollTop: number;
    resolved: "pending" | "sheet" | "scroll";
  } | null>(null);

  const heights: Record<SheetDetent, number> = {
    peek: PEEK_PX,
    half: Math.round(vh * HALF_RATIO),
    full: Math.round(vh * FULL_RATIO),
  };
  const fullPx = heights.full;
  const translateFor = (h: number) => fullPx - h;
  const minTranslate = 0;
  const maxTranslate = translateFor(heights.peek);
  const baseTranslate = translateFor(heights[detent]);
  const translate = Math.min(
    maxTranslate,
    Math.max(minTranslate, baseTranslate + (dragging ? dragOffset : 0)),
  );

  // Escape always collapses to peek — the sheet is non-modal, so this is a
  // convenience shortcut, not a focus-trap escape hatch.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && detent !== "peek") onDetentChange("peek");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detent, onDetentChange]);

  // Close the overflow menu on outside click / Escape.
  React.useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function snapFromVelocity(dy: number, velocity: number) {
    const idx = DETENT_ORDER.indexOf(detent);
    let nextIdx = idx;
    if (velocity > FLING_VELOCITY) nextIdx = Math.min(DETENT_ORDER.length - 1, idx + 1);
    else if (velocity < -FLING_VELOCITY) nextIdx = Math.max(0, idx - 1);
    else {
      const finalTranslate = Math.min(maxTranslate, Math.max(minTranslate, baseTranslate + dy));
      let best = idx;
      let bestDist = Infinity;
      DETENT_ORDER.forEach((d, i) => {
        const dist = Math.abs(translateFor(heights[d]) - finalTranslate);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      nextIdx = best;
    }
    const next = DETENT_ORDER[nextIdx];
    if (next !== detent) onDetentChange(next);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // jsdom (RTL) doesn't implement the Pointer Events capture methods —
    // every real browser does, so this is a test-environment guard, not a
    // feature check.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startTime: performance.now(),
      lastY: e.clientY,
      lastTime: performance.now(),
    };
    setDragging(true);
    setDragOffset(0);
  }
  function handlePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const st = dragRef.current;
    if (!st) return;
    setDragOffset(e.clientY - st.startY);
    st.lastY = e.clientY;
    st.lastTime = performance.now();
  }
  function handlePointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const st = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    setDragOffset(0);
    if (!st) return;
    const dy = st.lastY - st.startY;
    if (Math.abs(dy) < TAP_SLOP) {
      // A plain tap — let the click handler below cycle the detent so
      // keyboard activation (which never fires pointer events) behaves the
      // same way as a tap.
      return;
    }
    wasDragRef.current = true;
    const dt = Math.max(1, st.lastTime - st.startTime);
    snapFromVelocity(dy, dy / dt);
  }
  function handleHandleClick() {
    if (wasDragRef.current) {
      wasDragRef.current = false;
      return;
    }
    onDetentChange(nextDetent(detent));
  }

  // ── Content-area drag: a downward pull from the top of the scrolled list
  //    (scrollTop === 0) moves the sheet instead of the list rubber-banding.
  function handleContentPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    contentDragRef.current = {
      startY: e.clientY,
      startScrollTop: e.currentTarget.scrollTop,
      resolved: "pending",
    };
  }
  function handleContentPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const st = contentDragRef.current;
    if (!st) return;
    const dy = e.clientY - st.startY;
    if (st.resolved === "pending") {
      if (Math.abs(dy) < TAP_SLOP) return;
      st.resolved = dy > 0 && st.startScrollTop <= 0 ? "sheet" : "scroll";
      if (st.resolved === "sheet") {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        dragRef.current = {
          startY: st.startY,
          startTime: performance.now(),
          lastY: e.clientY,
          lastTime: performance.now(),
        };
        setDragging(true);
      }
    }
    if (st.resolved === "sheet") {
      e.preventDefault();
      setDragOffset(dy);
      if (dragRef.current) {
        dragRef.current.lastY = e.clientY;
        dragRef.current.lastTime = performance.now();
      }
    }
  }
  function handleContentPointerUp() {
    const st = contentDragRef.current;
    contentDragRef.current = null;
    if (st?.resolved === "sheet") {
      const dr = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setDragOffset(0);
      if (dr) {
        const dy = dr.lastY - dr.startY;
        const dt = Math.max(1, dr.lastTime - dr.startTime);
        snapFromVelocity(dy, dy / dt);
      }
    }
  }

  const expanded = detent !== "peek";
  const tapHint = detent === "full" ? "Tap to collapse" : "Tap to expand";

  return (
    <div
      data-testid="delivery-sheet"
      data-detent={detent}
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-surface-border bg-white shadow-[0_-4px_24px_rgba(15,23,42,0.12)]",
        className,
      )}
      style={{
        height: fullPx,
        paddingBottom: "env(safe-area-inset-bottom)",
        transform: `translate3d(0, ${translate}px, 0)`,
        transition:
          dragging || reducedMotion ? "none" : "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)",
        touchAction: "none",
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Delivery details, ${DETENT_LABEL[detent]}. ${tapHint}.`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleHandleClick}
        className="flex h-11 w-full shrink-0 items-center justify-center"
      >
        <span className="h-1.5 w-10 rounded-full bg-surface-border" aria-hidden />
      </button>

      <div className="flex shrink-0 items-center gap-2 px-4 pb-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-navy">{summary}</span>

        {overflow && overflow.length > 0 && (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More delivery actions"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-navy/70 hover:bg-surface-raised"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-40 mt-1 w-48 rounded-lg border border-surface-border bg-white p-1 shadow-lg"
              >
                {overflow.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    onClick={() => {
                      if (!action.keepOpen) setMenuOpen(false);
                      action.onClick();
                    }}
                    className={cn(
                      "flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-50",
                      action.destructive
                        ? "text-danger hover:bg-danger-bg"
                        : "text-navy hover:bg-surface-raised",
                    )}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={primary.onClick}
          disabled={primary.disabled}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {primary.loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {primary.label}
        </button>
      </div>

      <div
        data-testid="delivery-sheet-content"
        onPointerDown={handleContentPointerDown}
        onPointerMove={handleContentPointerMove}
        onPointerUp={handleContentPointerUp}
        onPointerCancel={handleContentPointerUp}
        className="flex-1 overflow-y-auto px-4 pb-4"
        style={{ touchAction: dragging ? "none" : "pan-y" }}
      >
        {children}
      </div>
    </div>
  );
}
