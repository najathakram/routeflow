/** One successful price save, as the save bar reports it (V07). `saveId` names the write to invert. */
export interface SavedPriceChange {
  saveId: string;
  /** Server-written one-line summary, e.g. "3 prices changed." (never computed in the UI). */
  summary: string;
}

/** One row of the preview-first state: values arrive pre-formatted from the server. */
export interface UndoPreviewRow {
  ref: string;
  label: string;
  current: string;
  restoreTo: string;
}

export type UndoOutcome =
  | { status: "undone" }
  /** The prices changed since the save: nothing was written; review these rows first. */
  | { status: "changed"; rows: UndoPreviewRow[] };

/** The inverse write. ONE call per Undo; `confirmed` is true only after the preview was accepted. */
export interface UndoPriceSaveApi {
  undo(change: SavedPriceChange, opts?: { confirmed?: boolean }): Promise<UndoOutcome>;
}
