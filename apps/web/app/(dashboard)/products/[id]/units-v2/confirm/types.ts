import type { UndoSkipCell } from "@routeflow/types";

/** What the status line needs of K3's `lastSave` (a subset of `SavePricesResponse`). */
export interface LastSave {
  auditId: string;
  /** priceRevision after the save. */
  revision: number;
  /** The inverse write; only its LENGTHS are read (counts for the summary, never money values). */
  undo?: { patches: readonly unknown[]; customerMoves: readonly unknown[] };
  /** K12 F05: Auto prices that followed the set prices of a Change prices Apply (0 or absent when none). */
  follows?: number;
}

/** One row of the preview-first state: values arrive pre-formatted (no money math in the UI). */
export interface UndoPreviewRow {
  ref: string;
  label: string;
  current: string;
  restoreTo: string;
}

/** The precondition the preview was built on; a confirmed Undo re-sends it, never the stale one. Both are required. */
export interface UndoPrecondition {
  expectedRevision: number;
  expectedPriceState: string;
}

/** A customer cell the strict undo refused (409 `conflicts`): the display row, and the skip entry that leaves it be. */
export interface UndoConflict {
  row: UndoPreviewRow;
  /** `seen` = the value the preview shows (the conflict's `current`). */
  skip: UndoSkipCell;
}

export type UndoOutcome =
  /** `skipped` = how many customer cells the skip list left as they were. */
  | { status: "undone"; skipped?: number }
  /** Prices moved since the save: nothing was written. `revision`/`priceState` are the FRESH grid's. */
  | {
      status: "changed";
      revision: number;
      priceState: string;
      rows: UndoPreviewRow[];
      /** Customer prices the inverse also writes; the preview says so (SA-799: never hidden). */
      customerMoves?: number;
      /** Customer cells that changed since the save (strict undo, 409 `conflicts`). */
      conflicts?: UndoConflict[];
    }
  /** 409 PRICE_UNDO_UNAVAILABLE: this audit row was already undone. */
  | { status: "unavailable" };

/** The shell-supplied inverse write. ONE call per click; `confirmed` only after the preview. */
export type UndoFn = (
  req: { confirmed: false } | ({ confirmed: true; skip?: UndoSkipCell[] } & UndoPrecondition),
) => Promise<UndoOutcome>;
