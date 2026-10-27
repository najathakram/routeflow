import { buildLadderView, ladderPrice } from "./price-ladder";
import {
  resolveLadderLevel,
  resolveUnitPrice,
  type LadderProduct,
  type LadderUnit,
} from "./unit-levels";

/** Row 621 (SA-971): the base ROW is the factor-1 row; the label only picks which level a line asks for. */
const box: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: 12 };
const row = (over: Partial<LadderUnit>): LadderUnit => ({
  label: "Piece",
  factorToBase: 1,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  ...over,
});

describe("row 621: the base row is the factor-1 row", () => {
  it("RED: a 1-piece row named 'Each' (not the base word) prices a 'Piece' line at its own 0.80, as the ladder shows", () => {
    const units = [row({ id: "e1", label: "Each", price: 0.8 } as Partial<LadderUnit>)];
    const level = resolveLadderLevel(box, units, "Piece");
    expect(level.kind).toBe("piece");
    expect(level.row?.label).toBe("Each");
    expect(resolveUnitPrice(box, units, "Piece", 1)).toBe(0.8);
    const view = buildLadderView(box, units as never);
    expect(ladderPrice(view, "base", 1)).toBe(0.8);
  });

  it("GUARD: a factor-6 row labelled 'Piece' stays invisible; 'Piece' is derived 1.00", () => {
    const units = [row({ label: "Piece", factorToBase: 6, price: 5 })];
    expect(resolveLadderLevel(box, units, "Piece").row).toBeNull();
    expect(resolveUnitPrice(box, units, "Piece", 1)).toBe(1);
  });

  it("GUARD: a 'Piece' with no factor-1 row is the implicit piece (derived)", () => {
    expect(resolveLadderLevel(box, [], "Piece").row).toBeNull();
    expect(resolveUnitPrice(box, [], "Piece", 1)).toBe(1);
  });

  it("GUARD: the usual base row named like the base word prices at its own price", () => {
    const units = [row({ label: "Piece", price: 0.9 })];
    expect(resolveUnitPrice(box, units, "Piece", 1)).toBe(0.9);
  });
});
