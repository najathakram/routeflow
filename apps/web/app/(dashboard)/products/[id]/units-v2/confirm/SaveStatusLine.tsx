"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { Button } from "@routeflow/ui/web";
import { UNITS_V2_CONFIRM_TESTIDS as IDS } from "./confirm-testids";
import type { UndoSkipCell } from "@routeflow/types";
import type { LastSave, UndoConflict, UndoFn, UndoPreviewRow } from "./types";
import { useEscapeCloses } from "./useEscapeCloses";

/** K11-16: how long the saved line holds the Edit bar's slot, and the fade that lets go of it. */
const PIN_MS = 5000;
const FADE_MS = 150;

/** "on" = pinned in the bar's slot, "fading" = letting go, "off" = settled in its place in the section. */
type Pin = "on" | "fading" | "off";

type Phase = "idle" | "saved" | "preview" | "undone" | "error" | "unavailable";
interface State {
  phase: Phase;
  auditId: string | null;
  summary: string;
  rows: UndoPreviewRow[];
  /** Customer prices the inverse also writes. */
  customerMoves: number;
  /** Customer cells that changed since the save. */
  conflicts: UndoConflict[];
  /** How many customer cells the finished Undo left as they were. */
  skipped: number;
  /** The preview's precondition, kept for the confirmed write. */
  revision?: number;
  priceState?: string;
  busy: boolean;
  pin: Pin;
}
type Action =
  | { type: "fade" }
  | { type: "unpin" }
  | { type: "saved"; auditId: string; summary: string }
  | { type: "edit" }
  | { type: "cleared" }
  | { type: "busy" }
  | { type: "undone"; skipped: number }
  | { type: "unavailable" }
  | {
      type: "preview";
      rows: UndoPreviewRow[];
      revision: number;
      priceState: string;
      customerMoves: number;
      conflicts: UndoConflict[];
    }
  | { type: "dismiss" }
  | { type: "failed" };

const IDLE: State = {
  phase: "idle",
  auditId: null,
  summary: "",
  rows: [],
  customerMoves: 0,
  conflicts: [],
  skipped: 0,
  busy: false,
  pin: "off",
};

function reduce(s: State, a: Action): State {
  switch (a.type) {
    case "saved":
      return { ...IDLE, phase: "saved", auditId: a.auditId, summary: a.summary, pin: "on" };
    case "edit":
      return s.phase === "idle" ? s : IDLE;
    case "cleared":
      // The draft forgot its save: an Undo-able line goes, but a finished Undo's answer stays on screen.
      return s.phase === "saved" || s.phase === "preview" || s.phase === "error" ? IDLE : s;
    case "fade":
      return s.pin === "on" ? { ...s, pin: "fading" } : s;
    case "unpin":
      return s.pin === "off" ? s : { ...s, pin: "off" };
    case "busy":
      return { ...s, busy: true };
    case "undone":
      return { ...IDLE, phase: "undone", skipped: a.skipped };
    case "unavailable":
      return { ...IDLE, phase: "unavailable" };
    case "preview":
      return {
        ...s,
        phase: "preview",
        rows: a.rows,
        customerMoves: a.customerMoves,
        conflicts: a.conflicts,
        revision: a.revision,
        priceState: a.priceState,
        busy: false,
        pin: "off",
      };
    case "dismiss":
      return { ...s, phase: "saved", rows: [], busy: false, pin: "off" };
    case "failed":
      return { ...s, phase: "error", rows: [], busy: false, pin: "off" };
  }
}

/**
 * The bar's current look (rounded-lg border, bg-white/95 + blur, px-4 py-3), but `fixed`: a sticky element only sticks
 * inside its containing block, and this line sits right after the grid, so a sticky line stopped where its section ends.
 * Fixed docks it at the viewport bottom whatever the page above it is; `usePinnedBox` gives it the content column's
 * left/width and the gap under the shell's scroller.
 */
const PINNED_CLASS =
  "fixed z-30 flex flex-wrap items-center gap-2 rounded-lg border border-surface-border bg-white/95 px-4 py-3 text-[13px] text-navy backdrop-blur outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500";
const FADING_CLASS = " opacity-0 transition-opacity duration-150 motion-reduce:transition-none";
const SETTLED_CLASS =
  "mt-2 scroll-mt-[var(--jump-offset,0px)] flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-surface-raised px-3 py-2 text-[13px] text-navy outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500";

interface PinnedBox {
  bottom: number;
  left?: number;
  width?: number;
}

const px = (v: string) =>
  Number.isFinite(Number(v.replace("px", ""))) ? Number(v.replace("px", "")) : 0;

/**
 * Where the fixed saved line goes: `bottom` is the gap between the shell's scroller (`#main-content`) and the viewport
 * bottom (0 with no shell), so it rests exactly where the sticky bar does; `left` / `width` are the content box of the
 * parent of the line's slot (the in-flow wrapper), so it stays in the page's content column. Re-measured on resize while pinned.
 */
function usePinnedBox(active: boolean, slot: React.RefObject<HTMLElement | null>): PinnedBox {
  const [box, setBox] = React.useState<PinnedBox>({ bottom: 0 });
  React.useLayoutEffect(() => {
    if (!active) return undefined;
    const measure = () => {
      const main = document.getElementById("main-content");
      const bottom = main
        ? Math.max(0, Math.round(window.innerHeight - main.getBoundingClientRect().bottom))
        : 0;
      const parent = slot.current?.parentElement;
      const next: PinnedBox = { bottom };
      if (parent) {
        const rect = parent.getBoundingClientRect();
        const cs = getComputedStyle(parent);
        const left = rect.left + px(cs.paddingLeft);
        const width = rect.width - px(cs.paddingLeft) - px(cs.paddingRight);
        if (width > 0) {
          next.left = Math.round(left);
          next.width = Math.round(width);
        }
      }
      setBox((prev) =>
        prev.bottom === next.bottom && prev.left === next.left && prev.width === next.width
          ? prev
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active, slot]);
  return box;
}

/**
 * While the line is pinned it is `fixed` and takes no space in the section, so when it settles back into the flow whatever
 * follows would jump down by its height (K11-16, +45.5 px at every width). This is the height to hold open in its slot
 * while pinned (null otherwise): the pinned node's own `offsetHeight`, re-measured when its content or the column width
 * changes (`key`, a window resize, a ResizeObserver where there is one). Derived from `active` on every render, so the
 * reservation is dropped in the very render the node settles.
 */
function useReservedHeight(
  active: boolean,
  line: React.RefObject<HTMLElement | null>,
  key: string,
): number | null {
  const [height, setHeight] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    if (!active) {
      setHeight(null);
      return undefined;
    }
    const el = line.current;
    if (!el) return undefined;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) setHeight((prev) => (prev === h ? prev : h));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [active, line, key]);
  return active ? height : null;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 prices" / "1 price and 2 customer prices", from the inverse's LENGTHS only (no money math). */
export function savedDetail(undo: LastSave["undo"], follows = 0): string {
  const n = undo?.patches.length ?? 0;
  const m = undo?.customerMoves.length ?? 0;
  const parts = [
    n ? plural(n, "price", "prices") : "",
    m ? plural(m, "customer price", "customer prices") : "",
  ];
  const set = parts.filter(Boolean).join(" and ");
  // K12 F05: the Auto prices that followed Change prices' set prices, in the unit the panel counted.
  return set && follows > 0
    ? `${set}; ${follows} Auto price${follows === 1 ? "" : "s"} followed`
    : set;
}

/**
 * "Saved 3 prices. Undo" where the change happened: the pricing section status line, never a toast (V07).
 * `lastSave` and `dirty` come from K3's draft; the line shows for each new save and clears on the next edit.
 * "Save undone." / "can't be undone any more" survive the draft forgetting its save (`onUndone`) and clear only on `dirty`.
 */
export function PriceSaveStatusLine({
  lastSave,
  dirty = false,
  undo,
  onUndone,
  id = "units-msg",
  idleUnmounted = false,
}: {
  lastSave: LastSave | null;
  dirty?: boolean;
  undo: UndoFn;
  /** Called once an Undo succeeded, so the draft can forget its `lastSave` (K3's `markUndone`). */
  onUndone?: () => void;
  id?: string;
  /** K11-20c: render no node while idle, so a second surface's line never adds a second live region to the page. */
  idleUnmounted?: boolean;
}) {
  const [state, dispatch] = React.useReducer(reduce, IDLE);
  const lineRef = React.useRef<HTMLDivElement>(null);
  const slotRef = React.useRef<HTMLDivElement>(null);
  const undoRef = React.useRef<HTMLButtonElement>(null);
  const refocusUndo = React.useRef(false);
  const live = React.useRef<string | null>(null);
  live.current = state.auditId;

  const auditId = lastSave?.auditId ?? null;
  const detail = savedDetail(lastSave?.undo, lastSave?.follows);
  React.useEffect(() => {
    if (auditId) dispatch({ type: "saved", auditId, summary: detail });
    else dispatch({ type: "cleared" });
  }, [auditId, detail]);
  React.useEffect(() => {
    if (dirty) dispatch({ type: "edit" });
  }, [dirty]);

  const { phase, busy } = state;
  const previewing = phase === "preview";
  const pinned = phase === "saved" && state.pin !== "off";

  // K11-16: the 5 s in the bar's slot. It restarts on each new save, and waits while the pointer is over the line or
  // focus is inside it (never un-pin under a focused Undo). Hover and focus are forgotten once the Undo is gone: a
  // removed node fires no mouseleave or blur.
  const [hover, setHover] = React.useState(false);
  const [focusIn, setFocusIn] = React.useState(false);
  const hold = hover || focusIn;
  const hasUndoNow = phase === "saved" || previewing || phase === "error";
  React.useEffect(() => {
    if (hasUndoNow) return;
    setHover(false);
    setFocusIn(false);
  }, [hasUndoNow]);
  const pinOn = phase === "saved" && state.pin === "on";
  React.useEffect(() => {
    if (!pinOn || hold) return;
    const t = setTimeout(() => {
      // A line that pinned under a pointer already resting there (where the bar's Save was) never got mouseenter, but
      // the browser reports it as :hover: hold it, and its mouseleave gives the 5 s back (K11-20c).
      if (lineRef.current?.matches?.(":hover")) return setHover(true);
      dispatch({ type: prefersReducedMotion() ? "unpin" : "fade" });
    }, PIN_MS);
    return () => clearTimeout(t);
  }, [pinOn, hold, state.auditId]);
  React.useEffect(() => {
    if (state.pin !== "fading") return;
    const t = setTimeout(() => dispatch({ type: "unpin" }), FADE_MS);
    return () => clearTimeout(t);
  }, [state.pin]);
  const box = usePinnedBox(pinned, slotRef);
  const reserved = useReservedHeight(
    pinned,
    lineRef,
    `${detail}|${phase}|${box.left}|${box.width}|${box.bottom}`,
  );

  const onUndoClick = () => {
    if (previewing) return close();
    if (pinned) {
      // Un-pin first (synchronously, so the line is back in its place), then bring it into view, then show the preview.
      flushSync(() => dispatch({ type: "unpin" }));
      lineRef.current?.scrollIntoView?.({ block: "nearest" });
    }
    void run(false);
  };
  const close = React.useCallback(() => {
    refocusUndo.current = true;
    dispatch({ type: "dismiss" });
  }, []);
  useEscapeCloses(previewing, close, undoRef);

  React.useEffect(() => {
    if (phase === "undone" || phase === "unavailable") lineRef.current?.focus();
    else if (refocusUndo.current && (phase === "saved" || phase === "error"))
      undoRef.current?.focus();
    refocusUndo.current = false;
  }, [phase]);

  // K13 F12: a new save puts focus on the line (the Save button just left the page), so Undo is the next Tab stop. Only
  // when focus has nowhere to be (a user who moved on keeps theirs), and never scrolling: the line is pinned in view.
  // That focus is not the user "being in" the line, so it does not hold the 5 s pin (a Tab onto Undo does).
  const autoFocus = React.useRef(false);
  const savedAudit = phase === "saved" ? state.auditId : null;
  React.useEffect(() => {
    if (!savedAudit) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    autoFocus.current = true;
    lineRef.current?.focus({ preventScroll: true });
    autoFocus.current = false;
  }, [savedAudit]);

  // Row 614: `busy` is state, stale inside one tick; this ref is set synchronously so a double click runs one Undo.
  const running = React.useRef(false);
  const run = async (confirmed: boolean, skip?: UndoSkipCell[]) => {
    const mine = state.auditId;
    if (!mine || busy || running.current) return;
    if (confirmed && (state.revision === undefined || !state.priceState)) return;
    running.current = true;
    dispatch({ type: "busy" });
    try {
      const out = await undo(
        confirmed && state.revision !== undefined && state.priceState
          ? {
              confirmed,
              expectedRevision: state.revision,
              expectedPriceState: state.priceState,
              ...(skip ? { skip } : {}),
            }
          : { confirmed: false },
      );
      if (live.current !== mine) return; // an edit or a newer save superseded this Undo
      if (out.status === "changed") {
        dispatch({
          type: "preview",
          rows: out.rows,
          revision: out.revision,
          priceState: out.priceState,
          customerMoves: out.customerMoves ?? 0,
          conflicts: out.conflicts ?? [],
        });
      } else {
        if (out.status === "undone") {
          dispatch({ type: "undone", skipped: out.skipped ?? 0 });
          onUndone?.();
        } else dispatch({ type: out.status });
      }
    } catch {
      if (live.current !== mine) return;
      refocusUndo.current = true;
      dispatch({ type: "failed" });
    } finally {
      running.current = false;
    }
  };

  const hasUndo = phase === "saved" || previewing || phase === "error";
  const previewId = `${id}-preview`;
  if (idleUnmounted && phase === "idle") return null;
  return (
    <>
      {/* K11-16: an ordinary in-flow slot (no role, one live region inside it). While the line is pinned the slot holds
          its height open, so settling back into the flow moves nothing. */}
      <div ref={slotRef} style={reserved ? { minHeight: `${reserved}px` } : undefined}>
        <div
          id={id}
          ref={lineRef}
          role="status"
          tabIndex={-1}
          data-testid={IDS.saveStatus}
          data-pinned={
            phase === "saved" ? (state.pin === "fading" ? "settling" : String(pinned)) : "false"
          }
          style={
            pinned
              ? box.width !== undefined
                ? { bottom: `${box.bottom}px`, left: `${box.left}px`, width: `${box.width}px` }
                : { bottom: `${box.bottom}px`, left: 0, right: 0 }
              : undefined
          }
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onFocus={() => {
            if (!autoFocus.current) setFocusIn(true);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false);
          }}
          className={
            phase === "idle"
              ? undefined
              : pinned
                ? PINNED_CLASS + (state.pin === "fading" ? FADING_CLASS : "")
                : SETTLED_CLASS
          }
        >
          {hasUndo ? (
            <>
              <span>
                <strong>{detail ? "Saved" : "Saved."}</strong>
                {detail ? ` ${detail}.` : ""}
              </span>
              {phase === "error" ? <span>Couldn&apos;t undo. Try again.</span> : null}
              <Button
                id={`${id}-undo`}
                ref={undoRef}
                type="button"
                size="sm"
                variant="link"
                data-testid={IDS.saveUndo}
                aria-expanded={previewing}
                aria-controls={previewing ? previewId : undefined}
                aria-disabled={busy || undefined}
                onClick={onUndoClick}
              >
                Undo
              </Button>
            </>
          ) : null}
          {phase === "undone" ? (
            <span>
              {state.skipped > 0
                ? `Undone. Kept ${plural(state.skipped, "customer price", "customer prices")} that changed since.`
                : "Save undone."}
            </span>
          ) : null}
          {phase === "unavailable" ? <span>This save can&apos;t be undone any more.</span> : null}
        </div>
      </div>
      {previewing ? (
        <div
          id={previewId}
          role="group"
          aria-label="Prices changed since you saved"
          data-testid={IDS.undoPreview}
          className="mt-2 rounded-ctl border border-line-strong bg-paper px-3 py-2 text-[13px]"
        >
          <p className="mb-1 text-navy">Prices changed since you saved. Undo would set:</p>
          <ul className="mb-2 space-y-0.5">
            {state.rows.map((r) => (
              <li key={r.ref} className="flex flex-wrap gap-x-2">
                <span>{r.label}</span>
                <span className="text-ink-500">{r.current}</span>
                <span aria-hidden="true">→</span>
                <span className="sr-only">would become</span>
                <span>{r.restoreTo}</span>
              </li>
            ))}
          </ul>
          {state.conflicts.length > 0 ? (
            <div data-testid={IDS.undoConflicts} className="mb-2">
              <p className="text-navy">Customer prices changed since you saved:</p>
              <ul className="mt-0.5 space-y-0.5">
                {state.conflicts.map(({ row: r }) => (
                  <li key={r.ref} className="flex flex-wrap gap-x-2">
                    <span>{r.label}</span>
                    <span className="text-ink-500">{r.current}</span>
                    <span aria-hidden="true">→</span>
                    <span className="sr-only">Undo would restore</span>
                    <span>{r.restoreTo}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.customerMoves > 0 ? (
            <p className="mb-2 text-navy">
              and {plural(state.customerMoves, "customer price", "customer prices")}
            </p>
          ) : null}
          <div className="flex gap-2">
            {state.conflicts.length > 0 ? (
              // With conflicts the server refuses a plain confirm: the only way forward is to leave those cells be.
              <Button
                type="button"
                size="sm"
                disabled={busy}
                data-testid={IDS.undoSkip}
                onClick={() =>
                  run(
                    true,
                    state.conflicts.map((c) => c.skip),
                  )
                }
              >
                Skip these customer prices and undo the rest
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={busy} onClick={() => run(true)}>
                Undo these prices
              </Button>
            )}
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={close}>
              Keep current prices
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
