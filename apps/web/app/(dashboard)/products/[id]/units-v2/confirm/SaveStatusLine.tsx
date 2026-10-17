"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { Button } from "@routeflow/ui/web";
import { UNITS_V2_CONFIRM_TESTIDS as IDS } from "./confirm-testids";
import type { UndoSkipCell } from "@routeflow/types";
import type { LastSave, UndoConflict, UndoFn, UndoPreviewRow } from "./types";
import { useShellBottom } from "../edit/useClearOfShellPadding";
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

/** The bar's look (PriceEditBar: sticky, border-t, bg-white/95 + blur, -mx-4 px-4), on the one live region. */
const PINNED_CLASS =
  "sticky z-30 -mx-4 mt-2 flex flex-wrap items-center gap-2 border-t border-surface-border bg-white/95 px-4 py-2 text-[13px] text-navy backdrop-blur focus:outline-none";
const FADING_CLASS = " opacity-0 transition-opacity duration-150 motion-reduce:transition-none";
const SETTLED_CLASS =
  "mt-2 flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-surface-raised px-3 py-2 text-[13px] text-navy focus:outline-none";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 prices" / "1 price and 2 customer prices", from the inverse's LENGTHS only (no money math). */
export function savedDetail(undo: LastSave["undo"]): string {
  const n = undo?.patches.length ?? 0;
  const m = undo?.customerMoves.length ?? 0;
  const parts = [
    n ? plural(n, "price", "prices") : "",
    m ? plural(m, "customer price", "customer prices") : "",
  ];
  return parts.filter(Boolean).join(" and ");
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
}: {
  lastSave: LastSave | null;
  dirty?: boolean;
  undo: UndoFn;
  /** Called once an Undo succeeded, so the draft can forget its `lastSave` (K3's `markUndone`). */
  onUndone?: () => void;
  id?: string;
}) {
  const [state, dispatch] = React.useReducer(reduce, IDLE);
  const lineRef = React.useRef<HTMLDivElement>(null);
  const undoRef = React.useRef<HTMLButtonElement>(null);
  const refocusUndo = React.useRef(false);
  const live = React.useRef<string | null>(null);
  live.current = state.auditId;

  const auditId = lastSave?.auditId ?? null;
  const detail = savedDetail(lastSave?.undo);
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
    const t = setTimeout(
      () => dispatch({ type: prefersReducedMotion() ? "unpin" : "fade" }),
      PIN_MS,
    );
    return () => clearTimeout(t);
  }, [pinOn, hold, state.auditId]);
  React.useEffect(() => {
    if (state.pin !== "fading") return;
    const t = setTimeout(() => dispatch({ type: "unpin" }), FADE_MS);
    return () => clearTimeout(t);
  }, [state.pin]);
  const shellBottom = useShellBottom(pinned);

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

  const run = async (confirmed: boolean, skip?: UndoSkipCell[]) => {
    const mine = state.auditId;
    if (!mine || busy) return;
    if (confirmed && (state.revision === undefined || !state.priceState)) return;
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
    }
  };

  const hasUndo = phase === "saved" || previewing || phase === "error";
  const previewId = `${id}-preview`;
  return (
    <>
      <div
        id={id}
        ref={lineRef}
        role="status"
        tabIndex={-1}
        data-testid={IDS.saveStatus}
        data-pinned={
          phase === "saved" ? (state.pin === "fading" ? "settling" : String(pinned)) : "false"
        }
        style={pinned ? { bottom: `${shellBottom}px` } : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocusIn(true)}
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
