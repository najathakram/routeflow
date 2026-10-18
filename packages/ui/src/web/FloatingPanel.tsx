"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./utils";
import { ModalNoticeContext } from "./Modal";

/** Breakpoint at and above which `variant="auto"` is an anchored panel (Tailwind `md`). */
const WIDE_QUERY = "(min-width: 768px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** A ref or a getter for an element: the getter form lets a caller resolve it at open/close time. */
export type FloatingPanelTarget =
  React.RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined);

export interface FloatingPanelProps {
  open: boolean;
  /** Radix asks to close (Close button, or Escape / an outside press the handlers below let through). */
  onOpenChange: (open: boolean) => void;
  /** The card the panel hangs off: its right edge is the panel's right edge (anchored variant). */
  anchor: HTMLElement | null | undefined;
  /** What opened it: the panel sits 8 px below this element and grows out of its centre. */
  origin: HTMLElement | null | undefined;
  /** Visible title; also the dialog's accessible name. */
  title: string;
  /** Read by screen readers only (e.g. the record's name); never rendered visibly. */
  description?: string;
  /** "auto" is anchored at >= 768 px and a bottom sheet below. Re-checked when the viewport changes. */
  variant?: "auto" | "anchored" | "sheet";
  /** Where focus goes on open. Never the Close button; omitted, focus lands on the panel itself. */
  initialFocus?: FloatingPanelTarget;
  /**
   * Fallback only: where focus goes on close when the element that had focus at open (the opener) is gone. Tried
   * after the opener and before `origin`.
   */
  returnFocus?: FloatingPanelTarget;
  /** Call `event.preventDefault()` to keep the panel open on Escape. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Call `event.preventDefault()` to keep the panel open on an outside press. */
  onInteractOutside?: (event: Event) => void;
  /** Extra pinned content under the title row (e.g. an actions row). Outside the scrolling body. */
  header?: React.ReactNode;
  /** Pinned footer (e.g. a Save bar). Pass `null` for none. */
  footer: React.ReactNode;
  /** The scrolling body. */
  children: React.ReactNode;
}

export interface AnchoredPlacementInput {
  /** Only the right edge is used; `null` aligns to the viewport's right side margin. */
  anchor: { right: number } | null;
  /** Only the bottom edge is used; `null` puts the panel at the top margin. */
  origin: { bottom: number } | null;
  /** The panel's laid-out size (offsetWidth / offsetHeight, not its animated bounding box). */
  panel: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Space between the origin's bottom and the panel's top. Default 8. */
  gap?: number;
  /** Top and bottom viewport margin. Default 24. */
  margin?: number;
  /** Left and right viewport margin. Default 16. */
  sideMargin?: number;
}

/**
 * Where the anchored panel's top-left corner goes (viewport coordinates, `position: fixed`).
 * Right edge on the anchor's right edge, so a wide panel grows leftward past the card; top `gap` below
 * the origin. Moves up until it fits above the bottom margin, and is pinned to the top margin when the
 * viewport is shorter than the panel. Pure, so the numbers are testable without a browser.
 */
export function computeAnchoredPlacement({
  anchor,
  origin,
  panel,
  viewport,
  gap = 8,
  margin = 24,
  sideMargin = 16,
}: AnchoredPlacementInput): { top: number; left: number } {
  const right = anchor ? anchor.right : viewport.width - sideMargin;
  const maxLeft = viewport.width - sideMargin - panel.width;
  const left = Math.max(sideMargin, Math.min(right - panel.width, maxLeft));

  const desiredTop = origin ? origin.bottom + gap : margin;
  const maxTop = viewport.height - margin - panel.height;
  const top = Math.max(margin, Math.min(desiredTop, maxTop));
  return { top, left };
}

function resolveTarget(target: FloatingPanelTarget | undefined): HTMLElement | null {
  if (!target) return null;
  return (typeof target === "function" ? target() : target.current) ?? null;
}

function readQuery(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  return window.matchMedia(query).matches;
}

/** Live `matchMedia` flag, re-read when the panel opens, on the query's change event and on resize. */
function useMediaQuery(query: string, fallback: boolean, open: boolean): boolean {
  const [matches, setMatches] = React.useState(() => readQuery(query, fallback));
  React.useEffect(() => {
    const sync = () => setMatches(readQuery(query, fallback));
    sync();
    if (typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(query);
    mql.addEventListener?.("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      mql.removeEventListener?.("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, [query, fallback, open]);
  return matches;
}

/**
 * Applies the anchored placement to the dialog content (its parent element) imperatively: measured on
 * open and on window resize (and when the panel's own height changes), written straight to the style so
 * the first paint is already in place and focus never lands on a hidden element.
 */
function Placement({
  anchor,
  origin,
  enabled,
}: {
  anchor: HTMLElement | null | undefined;
  origin: HTMLElement | null | undefined;
  enabled: boolean;
}) {
  const markerRef = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const node = markerRef.current?.parentElement;
    if (!node) return undefined;
    const clear = () => {
      node.style.removeProperty("top");
      node.style.removeProperty("left");
      node.style.removeProperty("transform-origin");
    };
    if (!enabled) {
      clear();
      return undefined;
    }
    const place = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const anchorRect = anchor?.getBoundingClientRect() ?? null;
      const originRect = origin?.getBoundingClientRect() ?? null;
      const { top, left } = computeAnchoredPlacement({
        anchor: anchorRect,
        origin: originRect,
        panel: { width: node.offsetWidth, height: node.offsetHeight },
        viewport,
      });
      node.style.top = `${Math.round(top)}px`;
      node.style.left = `${Math.round(left)}px`;
      // It grows out of what was clicked: the scale's origin is the origin element's centre.
      const grow = originRect ?? anchorRect;
      if (grow) {
        const cx = grow.left + grow.width / 2;
        const cy = grow.top + grow.height / 2;
        node.style.transformOrigin = `${Math.round(cx - left)}px ${Math.round(cy - top)}px`;
      } else {
        node.style.removeProperty("transform-origin");
      }
    };
    place();
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(node);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
      clear();
    };
  }, [anchor, origin, enabled]);
  return <span ref={markerRef} hidden data-floating-panel-marker />;
}

/**
 * A small modal window that hangs off the thing that opened it: an anchored panel at >= md, a bottom
 * sheet below. It LOOKS like a popover (compact, light scrim, no blur) and BEHAVES like a dialog (focus
 * trapped, page inert, role=dialog aria-modal), because it holds a task with an explicit commit: an
 * outside click or Escape reaches the caller's handlers first and never discards anything by itself
 * when the handler calls `preventDefault()`. No knowledge of what it contains.
 *
 * Motion is CSS keyed on the Radix `data-state`, so Escape or Close mid-open ends clean: open is
 * opacity + scale(0.97) in 150 ms (the sheet rises 24 px in 200 ms), close is opacity only in 120 ms,
 * and under `prefers-reduced-motion` there is no scale or translate class at all.
 */
export function FloatingPanel({
  open,
  onOpenChange,
  anchor,
  origin,
  title,
  description,
  variant = "auto",
  initialFocus,
  returnFocus,
  onEscapeKeyDown,
  onInteractOutside,
  header,
  footer,
  children,
}: FloatingPanelProps) {
  const notice = React.useContext(ModalNoticeContext);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);

  const wide = useMediaQuery(WIDE_QUERY, true, open);
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY, false, open);
  const resolved: "anchored" | "sheet" =
    variant === "auto" ? (wide ? "anchored" : "sheet") : variant;
  const sheet = resolved === "sheet";

  const durationOpen =
    sheet && !reduceMotion ? "data-[state=open]:duration-200" : "data-[state=open]:duration-150";

  return (
    <Dialog.Root modal open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* print:hidden: a printed page never carries the dimmed backdrop. No blur: a light scrim. */}
        <Dialog.Overlay
          data-floating-panel-scrim
          className={cn(
            "fixed inset-0 z-50 print:hidden",
            sheet ? "bg-black/30" : "bg-black/10",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            durationOpen,
            "data-[state=closed]:duration-[120ms]",
          )}
        />
        <Dialog.Content
          ref={contentRef}
          data-floating-panel
          data-variant={resolved}
          // Radix makes the page behind inert but does not set aria-modal itself.
          aria-modal="true"
          // The description is optional; opt out of Radix's missing-description warning when absent.
          {...(description ? {} : { "aria-describedby": undefined })}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={onInteractOutside}
          onOpenAutoFocus={(event) => {
            // Remember who had focus (the opener) for the return-focus fallback, then place focus
            // ourselves: the caller's target, else the panel. Never the first tabbable (the Close X).
            const active = document.activeElement;
            openerRef.current =
              active instanceof HTMLElement && active !== document.body ? active : null;
            event.preventDefault();
            (resolveTarget(initialFocus) ?? contentRef.current)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // The opener is not a Radix Dialog.Trigger, so restore focus explicitly: whatever had focus
            // at open (the clicked figure), else the caller's fallback, else the origin; skip any that
            // is gone.
            event.preventDefault();
            const target = [openerRef.current, resolveTarget(returnFocus), origin ?? null].find(
              (el): el is HTMLElement => !!el && el.isConnected,
            );
            target?.focus();
            openerRef.current = null;
          }}
          className={cn(
            "fixed z-50 flex flex-col bg-white shadow-modal outline-none",
            sheet
              ? "inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-2xl"
              : [
                  "left-4 top-6 w-[min(860px,calc(100vw-32px))] min-w-[min(560px,calc(100vw-32px))]",
                  "max-h-[min(40rem,calc(100dvh-48px))] rounded-xl",
                  // Contrast: more draws the edge the soft shadow and light scrim stop providing.
                  "contrast-more:border contrast-more:border-line-strong",
                ],
            // Keyed on data-state so an interrupt (Escape / Close mid-open) ends clean.
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:ease-out data-[state=closed]:ease-out",
            durationOpen,
            "data-[state=closed]:duration-[120ms]",
            // Reduced motion: opacity only, so these classes are simply absent. Closing is opacity only
            // in every case.
            !reduceMotion &&
              (sheet
                ? "data-[state=open]:slide-in-from-bottom-6"
                : "data-[state=open]:zoom-in-[0.97]"),
          )}
        >
          <Placement anchor={anchor} origin={origin} enabled={!sheet} />

          {/* Header: pinned */}
          <div className="shrink-0 px-4 pt-4">
            <div className="flex items-start justify-between gap-3">
              <Dialog.Title className="min-w-0 text-lg font-semibold text-navy">
                {title}
              </Dialog.Title>
              {/* No onClick: Dialog.Close routes through onOpenChange. */}
              <Dialog.Close
                aria-label="Close"
                className={cn(
                  "flex flex-shrink-0 items-center justify-center rounded text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  sheet ? "-mr-2 -mt-2 h-11 w-11" : "-mr-1 -mt-1 h-8 w-8",
                )}
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            {description ? (
              <Dialog.Description className="sr-only">{description}</Dialog.Description>
            ) : null}
            {header}
          </div>

          {notice ? (
            <div data-floating-panel-notice className="shrink-0 px-4 pt-3">
              {notice}
            </div>
          ) : null}

          {/* Body: the only part that scrolls */}
          <div
            data-floating-panel-body
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm text-navy/80"
          >
            {children}
          </div>

          {/* Footer: pinned */}
          {footer ? (
            <div
              data-floating-panel-footer
              className={cn(
                "shrink-0 border-t border-surface-border px-4 pt-3",
                sheet ? "pb-[calc(0.75rem+env(safe-area-inset-bottom))]" : "pb-3",
              )}
            >
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
