import type { ProductPriceGridDto } from "@routeflow/types";

/** K11-20a test fixtures: a three-unit ladder (Case > Box > Piece) with Set and Auto prices. */
const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));

export const GRID: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([24.5, 22, 21, 20, 19]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set"]),
    },
  ],
};

/** The same ladder with the Piece unit missing (the API serves a read-only implicit base row). */
export const MISSING_PIECE_GRID: ProductPriceGridDto = {
  ...GRID,
  rows: [
    GRID.rows[0],
    GRID.rows[1],
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: false,
      notEditableReason: "Add the Piece unit first.",
      code: null,
      cells: cells([0, 0, 0, 0, 0]),
    },
  ],
};

export const SAVED_GRID: ProductPriceGridDto = { ...GRID, revision: 8, priceState: "ps-2" };

export const PRODUCT = {
  id: "p1",
  name: "Acme widgets",
  unit: "Piece",
  unitsPerBox: 24,
  pricePerUnit: "0.92",
};

/** What a successful save answers (one patch to undo). */
export const SAVE_RESPONSE = {
  auditId: "a1",
  revision: 8,
  undo: { patches: [{ ref: "case", tier: 2, to: 13.91 }], customerMoves: [] },
  grid: SAVED_GRID,
};
