"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import type { SavedPriceChange, UndoPreviewRow } from "./types";
import { useEscapeCloses } from "./useEscapeCloses";
import { useUndoPriceSave } from "./useUndoPriceSave";

type Phase = "idle" | "saved" | "preview" | "undone" | "error";
export interface SaveStatusState {
  phase: Phase;
  saved: SavedPriceChange | null;
  rows: UndoPreviewRow[];
  busy: boolean;
}
type Action =
  | { type: "saved"; change: SavedPriceChange }
  | { type: "edit" }
  | { type: "busy" }
  | { type: "undone" }
  | { type: "preview"; rows: UndoPreviewRow[] }
  | { type: "dismiss" }
  | { type: "failed" };

const IDLE: SaveStatusState = { phase: "idle", saved: null, rows: [], busy: false };

function reduce(s: SaveStatusState, a: Action): SaveStatusState {
  switch (a.type) {
    case "saved":
      return { phase: "saved", saved: a.change, rows: [], busy: false };
    case "edit":
      return s.phase === "idle" ? s : IDLE;
    case "busy":
      return { ...s, busy: true };
    case "undone":
      return { phase: "undone", saved: null, rows: [], busy: false };
    case "preview":
      return { ...s, phase: "preview", rows: a.rows, busy: false };
    case "dismiss":
      return { ...s, phase: "saved", rows: [] };
    case "failed":
      return { ...s, phase: "error", busy: false };
  }
}

/**
 * State for the section status line (V07). The save bar calls `onSaved(change)` after a successful
 * save and `onEdit()` on the first draft change after it; the line keeps its Undo until then.
 */
export function usePriceSaveStatus() {
  const [state, dispatch] = React.useReducer(reduce, IDLE);
  const onSaved = React.useCallback(
    (change: SavedPriceChange) => dispatch({ type: "saved", change }),
    [],
  );
  const onEdit = React.useCallback(() => dispatch({ type: "edit" }), []);
  return { state, dispatch, onSaved, onEdit };
}

export const CONFIRM_TESTIDS = { line: "units-v2-save-line", undo: "units-v2-save-undo" } as const;

/** "Saved. {summary} Undo" where the change happened: the pricing section, never a toast. */
export function PriceSaveStatusLine({
  productId,
  status,
}: {
  productId: string;
  status: ReturnType<typeof usePriceSaveStatus>;
}) {
  const { state, dispatch } = status;
  const api = useUndoPriceSave(productId);
  const lineRef = React.useRef<HTMLDivElement>(null);
  const undoRef = React.useRef<HTMLButtonElement>(null);
  const liveId = React.useRef<string | null>(null);
  liveId.current = state.saved?.saveId ?? null;

  useEscapeCloses(state.phase === "preview", () => dispatch({ type: "dismiss" }), undoRef);

  const run = async (confirmed: boolean) => {
    const change = state.saved;
    if (!change || state.busy) return;
    dispatch({ type: "busy" });
    try {
      const out = await api.undo(change, confirmed ? { confirmed: true } : undefined);
      if (liveId.current !== change.saveId) return; // another edit or save superseded this Undo
      if (out.status === "undone") {
        dispatch({ type: "undone" });
        lineRef.current?.focus();
      } else dispatch({ type: "preview", rows: out.rows });
    } catch {
      if (liveId.current === change.saveId) dispatch({ type: "failed" });
    }
  };

  const { phase } = state;
  const hasUndo = phase === "saved" || phase === "preview" || phase === "error";
  return (
    <>
      <div
        id="units-msg"
        ref={lineRef}
        role="status"
        tabIndex={-1}
        data-testid={CONFIRM_TESTIDS.line}
        className={
          phase === "idle"
            ? undefined
            : "mt-2 flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-surface-raised px-3 py-2 text-[13px] text-navy focus:outline-none"
        }
      >
        {hasUndo ? (
          <>
            <span>
              <strong>Saved.</strong> {state.saved?.summary}
            </span>
            {phase === "error" ? <span>Couldn&apos;t undo. Try again.</span> : null}
            <Button
              id="msg-undo-save"
              ref={undoRef}
              type="button"
              size="sm"
              variant="link"
              data-testid={CONFIRM_TESTIDS.undo}
              aria-expanded={phase === "preview"}
              aria-disabled={state.busy || undefined}
              onClick={() => (phase === "preview" ? dispatch({ type: "dismiss" }) : run(false))}
            >
              Undo
            </Button>
          </>
        ) : null}
        {phase === "undone" ? <span>Save undone.</span> : null}
      </div>
      {phase === "preview" ? (
        <div
          role="group"
          aria-label="Prices changed since you saved"
          className="mt-2 rounded-ctl border border-line-strong bg-paper px-3 py-2 text-[13px]"
        >
          <p className="mb-1 text-navy">Prices changed since you saved. Undo would set:</p>
          <ul className="mb-2 space-y-0.5">
            {state.rows.map((r) => (
              <li key={r.ref} className="flex flex-wrap gap-x-2">
                <span>{r.label}</span>
                <span className="text-ink-500">{r.current}</span>
                <span aria-hidden="true">→</span>
                <span>{r.restoreTo}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => run(true)}>
              Undo these prices
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => dispatch({ type: "dismiss" })}
            >
              Keep current prices
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
