/** The edit-mode seam between the draft store (useGridEdit) and the prices grid. Types only. */
export interface CellFocus {
  ref: string;
  tier: number;
  layout: "table" | "card";
}

export interface GridEditApi {
  editing: boolean;
  /** Enter edit mode; `cell` asks for that cell's input to take focus. */
  begin: (cell?: CellFocus) => void;
  /** What the cell's input shows: the draft text, or `original` when untouched. */
  text: (ref: string, tier: number, original: string) => string;
  setText: (ref: string, tier: number, text: string, original: string) => void;
  /** True when the user has changed this cell in the draft. */
  changed: (ref: string, tier: number) => boolean;
  /** A pending focus request; the matching input takes it and calls `focused`. */
  focus: CellFocus | null;
  focused: () => void;
}
