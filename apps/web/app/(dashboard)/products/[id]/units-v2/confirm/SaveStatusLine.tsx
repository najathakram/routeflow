"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { UNITS_V2_CONFIRM_TESTIDS as IDS } from "./confirm-testids";
import type { LastSave, UndoFn, UndoPreviewRow } from "./types";
import { useEscapeCloses } from "./useEscapeCloses";

type Phase = "idle" | "saved" | "preview" | "undone" | "error" | "unavailable";
interface State {
  phase: Phase;
  auditId: string | null;
  summary: string;
  rows: UndoPreviewRow[];
  /** The preview's precondition, kept for the confirmed write. */
  revision?: number;
  priceState?: string;
  busy: boolean;
}
type Action =
  | { type: "saved"; auditId: string; summary: string }
  | { type: "edit" }
  | { type: "cleared" }
  | { type: "busy" }
  | { type: "undone" }
  | { type: "unavailable" }
  | { type: "preview"; rows: UndoPreviewRow[]; revision: number; priceState: string }
  | { type: "dismiss" }
  | { type: "failed" };

const IDLE: State = { phase: "idle", auditId: null, summary: "", rows: [], busy: false };

function reduce(s: State, a: Action): State {
  switch (a.type) {
    case "saved":
      return { ...IDLE, phase: "saved", auditId: a.auditId, summary: a.summary };
    case "edit":
      return s.phase === "idle" ? s : IDLE;
    case "cleared":
      // The draft forgot its save: an Undo-able line goes, but a finished Undo's answer stays on screen.
      return s.phase === "saved" || s.phase === "preview" || s.phase === "error" ? IDLE : s;
    case "busy":
      return { ...s, busy: true };
    case "undone":
      return { ...IDLE, phase: "undone" };
    case "unavailable":
      return { ...IDLE, phase: "unavailable" };
    case "preview":
      return {
        ...s,
        phase: "preview",
        rows: a.rows,
        revision: a.revision,
        priceState: a.priceState,
        busy: false,
      };
    case "dismiss":
      return { ...s, phase: "saved", rows: [], busy: false };
    case "failed":
      return { ...s, phase: "error", rows: [], busy: false };
  }
}

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

  const run = async (confirmed: boolean) => {
    const mine = state.auditId;
    if (!mine || busy) return;
    if (confirmed && (state.revision === undefined || !state.priceState)) return;
    dispatch({ type: "busy" });
    try {
      const out = await undo(
        confirmed && state.revision !== undefined && state.priceState
          ? { confirmed, expectedRevision: state.revision, expectedPriceState: state.priceState }
          : { confirmed: false },
      );
      if (live.current !== mine) return; // an edit or a newer save superseded this Undo
      if (out.status === "changed") {
        dispatch({
          type: "preview",
          rows: out.rows,
          revision: out.revision,
          priceState: out.priceState,
        });
      } else {
        dispatch({ type: out.status });
        if (out.status === "undone") onUndone?.();
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
        className={
          phase === "idle"
            ? undefined
            : "mt-2 flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-surface-raised px-3 py-2 text-[13px] text-navy focus:outline-none"
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
              onClick={() => (previewing ? close() : run(false))}
            >
              Undo
            </Button>
          </>
        ) : null}
        {phase === "undone" ? <span>Save undone.</span> : null}
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
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => run(true)}>
              Undo these prices
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={close}>
              Keep current prices
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
