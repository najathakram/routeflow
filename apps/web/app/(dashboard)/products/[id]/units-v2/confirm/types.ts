/** What the status line needs of K3's `lastSave` (a subset of `SavePricesResponse`). */
export interface LastSave {
  auditId: string;
  /** priceRevision after the save. */
  revision: number;
  /** The inverse write; only its LENGTHS are read (counts for the summary, never money values). */
  undo?: { patches: readonly unknown[]; customerMoves: readonly unknown[] };
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

export type UndoOutcome =
  | { status: "undone" }
  /** Prices moved since the save: nothing was written. `revision`/`priceState` are the FRESH grid's. */
  | {
      status: "changed";
      revision: number;
      priceState: string;
      rows: UndoPreviewRow[];
      /** Customer prices the inverse also writes; the preview says so (SA-799: never hidden). */
      customerMoves?: number;
      /** Customer cells that changed since the save (strict undo, 409 `conflicts`), as the server formatted them. */
      conflicts?: UndoPreviewRow[];
    }
  /** 409 PRICE_UNDO_UNAVAILABLE: this audit row was already undone. */
  | { status: "unavailable" };

/** The shell-supplied inverse write. ONE call per click; `confirmed` only after the preview. */
export type UndoFn = (
  req: { confirmed: false } | ({ confirmed: true } & UndoPrecondition),
) => Promise<UndoOutcome>;
