import type { ProductPriceGridRowDto } from "@routeflow/types";

/** The edit-mode seam between the draft store (usePriceDraft) and the prices grid. Types only. */
export interface CellFocus {
  ref: string;
  tier: number;
  layout: "table" | "card";
}

export interface GridEditApi {
  editing: boolean;
  /**
   * Enter edit mode in `surface` (default "inline"); `cell` asks for that cell's input to take focus. Returns false,
   * doing nothing, while the other surface is editing.
   */
  begin: (cell?: CellFocus, surface?: "inline" | "window") => boolean;
  /** What the cell's input shows: the draft text, or `original` when untouched. */
  text: (ref: string, tier: number, original: string) => string;
  setText: (ref: string, tier: number, text: string, original: string) => void;
  /** True when the user has changed this cell in the draft. */
  changed: (ref: string, tier: number) => boolean;
  /** The pricing package's refusal for this cell's typed text, if any. */
  problem: (ref: string, tier: number) => string | null;
  /**
   * The server's refusal of this cell's first price when its unit does not exist yet ("Add the Piece unit first").
   * Shown only while the typed text is the one the server refused.
   */
  addUnitProblem: (ref: string, tier: number) => string | null;
  /** The draft as grid rows once something changed (Auto placeholders show draft values); else null. */
  rows: ProductPriceGridRowDto[] | null;
  /** A pending focus request; the matching input takes it and calls `focused`. */
  focus: CellFocus | null;
  focused: () => void;
}
