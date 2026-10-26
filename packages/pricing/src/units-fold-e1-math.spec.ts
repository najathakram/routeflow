import { isDeepStrictEqual } from "node:util";
import { buildLine } from "./build-line";
import { regulatedUnitBasis } from "./regulated-unit-basis";
import { computeLineSubtotal, invoiceLineQtyText, roundMoney } from "./pricing";
import {
  describeBaseOption,
  planBaseBilling,
  resolveUnitPrice,
  type LadderProduct,
  type LadderUnit,
} from "./unit-levels";

/**
 * SA-984 §4 E1 / SA-987 §1.6 + Q2, layer A (pure math; @routeflow/pricing reads no flag, so nothing here toggles one).
 * Sell 5 loose pieces of a 12-pack at $11.00 once through today's split (boxes 0, pieces 5) and once through the new
 * Piece pick. The figures the DB rows must reproduce are pinned here, each beside the independent formula it equals.
 *
 * The pins are green by construction. The E1-b PARITY test compares OLD with NEW and goes red, printing both figures,
 * when the two sides differ: STOP RULE (SA-984 §5), that is a finding for the SA and the owner, never an expectation
 * to edit. E1-c (an own-priced Piece) is an INTENDED DIFFERENCE since SA-996: count x the typed price. Its two figures
 * are pinned beside their formulas, and tax basis, printed-piece count and the tier-5 row stay expectSame.
 */
const product: LadderProduct = {
  unit: "Box",
  unitsPerBox: 12,
  pricePerUnit: "11.00",
  priceTier2: "10.50",
  priceTier3: "10.00",
  priceTier4: "9.50",
  priceTier5: "9.00",
};
const noTiers = { priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null };
// E1-b: a Piece row with NO price of its own (Auto): the base is DERIVED from the pack
const AUTO: LadderUnit[] = [{ label: "Piece", factorToBase: 1, price: null, ...noTiers }];
// E1-c (Q2): an OWN-priced Piece row at the price the picker DISPLAYS for the derived Piece, per tier
const OWN: LadderUnit[] = [
  { label: "Piece", factorToBase: 1, price: "0.92", ...noTiers, priceTier3: "0.83" },
];

type Fig = Record<string, unknown>;
const show = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));
/** The failing-assertion form shared with apps/api's units-fold-battery.ts: OLD and NEW of every field that moved. */
function expectSame(cell: string, off: Fig, on: Fig): void {
  const diff = Object.keys({ ...off, ...on }).filter((k) => !isDeepStrictEqual(off[k], on[k]));
  if (diff.length === 0) return;
  throw new Error(
    `UNITS-FOLD DIFFERENCE ${cell}\n` +
      diff.map((k) => `  ${k}: OLD=${show(off[k])}  NEW=${show(on[k])}`).join("\n") +
      `\nSTOP (SA-984 §5): report both figures to the SA/owner. Do not edit this expectation.`,
  );
}

// OLD: today's split, stored as { qty 5, boxes 0, pieces 5, unitsPerBox 12 } and prorated on the pack price
const oldStored = { qty: 5, boxes: 0, pieces: 5, unitsPerBox: 12 };
const oldFig = (packPrice: number): Fig => ({
  subtotal: computeLineSubtotal({ unitPrice: packPrice, ...oldStored }),
  taxBasisPieces: regulatedUnitBasis(oldStored, 12).unitBasisQty,
  printedQty: invoiceLineQtyText(oldStored),
});
// NEW own-priced pick: buildLine's factor-1 unit axis at resolveUnitPrice(...)
const newOwnFig = (tier: number, rows: LadderUnit[] = OWN): Fig => {
  const unitPrice = resolveUnitPrice(product, rows, "Piece", tier);
  const line = buildLine({
    axis: { kind: "unit", label: "Piece", count: 5, factorToBase: 1 },
    unitPrice,
  });
  return {
    subtotal: line.subtotal,
    taxBasisPieces: regulatedUnitBasis(line, line.unitsPerBox).unitBasisQty,
    printedQty: invoiceLineQtyText(line),
  };
};

describe("E1 pure pins: today's split (OLD)", () => {
  it("tier 1: 11.00 x 5/12 = 4.5833 -> 4.58, five pieces of tax basis, printed '5 pcs'", () => {
    expect(oldFig(11)).toEqual({ subtotal: 4.58, taxBasisPieces: 5, printedQty: "5 pcs" });
  });
  it("tier 3: 10.00 x 5/12 = 4.1667 -> 4.17", () => {
    expect(oldFig(10)).toEqual({ subtotal: 4.17, taxBasisPieces: 5, printedQty: "5 pcs" });
  });
});

describe("E1 pure pins: the Piece the picker displays (Q2)", () => {
  it("the derived Piece shows roundMoney(11.00 / 12) = 0.92 at tier 1 and roundMoney(10.00 / 12) = 0.83 at tier 3", () => {
    expect(describeBaseOption(product, [], 1)).toMatchObject({
      price: 0.92,
      source: "derived",
      exact: false,
    });
    expect(describeBaseOption(product, [], 3)).toMatchObject({ price: 0.83, source: "derived" });
    expect(roundMoney(11 / 12)).toBe(0.92);
    expect(roundMoney(10 / 12)).toBe(0.83);
  });
  it("an own-priced Piece row is read back as the same displayed price", () => {
    expect(resolveUnitPrice(product, OWN, "Piece", 1)).toBe(0.92);
    expect(resolveUnitPrice(product, OWN, "Piece", 3)).toBe(0.83);
  });
});

describe("E1-b pure pins: a Piece with no price of its own bills as the pack's pieces", () => {
  it("planBaseBilling (Auto row, tier 1) is mode 'pack': boxes 0, pieces 5, prorated 4.58", () => {
    expect(planBaseBilling(product, AUTO, 1, 5)).toMatchObject({
      mode: "pack",
      boxes: 0,
      pieces: 5,
      qty: 5,
      packUnitPrice: 11,
      subtotal: 4.58,
    });
  });
  it("planBaseBilling (Auto row, tier 3) prorates the tier-3 pack price: 4.17", () => {
    expect(planBaseBilling(product, AUTO, 3, 5)).toMatchObject({
      mode: "pack",
      packUnitPrice: 10,
      subtotal: 4.17,
    });
  });
});

describe("E1-c pure pins: an own-priced Piece is a factor-1 unit line, count x P", () => {
  it("planBaseBilling (own row, tier 1) is mode 'unit': 5 x 0.92 = 4.60", () => {
    expect(planBaseBilling(product, OWN, 1, 5)).toMatchObject({
      mode: "unit",
      unitLabel: "Piece",
      unitPrice: 0.92,
      qty: 5,
      subtotal: 4.6,
    });
  });
  it("planBaseBilling (own row, tier 3): 5 x 0.83 = 4.15", () => {
    expect(planBaseBilling(product, OWN, 3, 5)).toMatchObject({
      mode: "unit",
      unitPrice: 0.83,
      subtotal: 4.15,
    });
  });
  it("the stored line is { qty 5, boxes null, pieces null, unitsPerBox 1, unitLabel 'Piece' }, tax basis 5, printed '5 Piece'", () => {
    const line = buildLine({
      axis: { kind: "unit", label: "Piece", count: 5, factorToBase: 1 },
      unitPrice: 0.92,
    });
    expect(line).toMatchObject({
      qty: 5,
      boxes: null,
      pieces: null,
      unitsPerBox: 1,
      unitLabel: "Piece",
      subtotal: 4.6,
    });
    expect(newOwnFig(1)).toEqual({ subtotal: 4.6, taxBasisPieces: 5, printedQty: "5 Piece" });
    expect(newOwnFig(3)).toEqual({ subtotal: 4.15, taxBasisPieces: 5, printedQty: "5 Piece" });
  });
});

describe("E1-b PARITY (OBSERVE AND REPORT): the derived Piece vs today's split, same pieces, same tier", () => {
  it("E1-b tier 1: the derived Piece is exactly today's split (the stored line is the same shape)", () => {
    const b = planBaseBilling(product, AUTO, 1, 5);
    if (b.mode !== "pack") throw new Error("E1-b must bill as the pack's pieces");
    const stored = { qty: b.qty, boxes: b.boxes, pieces: b.pieces, unitsPerBox: 12 };
    expectSame("E1-b tier1", oldFig(11), {
      subtotal: b.subtotal,
      taxBasisPieces: regulatedUnitBasis(stored, 12).unitBasisQty,
      printedQty: invoiceLineQtyText(stored),
    });
  });
});

describe("E1-c intended difference (SA-996): an own-priced Piece is count x P; the whole gap is P rounded to cents", () => {
  /** The axes that stay expectSame (any difference stays a STOP): the pieces the tax basis counts. */
  const basis = (f: Fig): Fig => ({ taxBasisPieces: f.taxBasisPieces });
  it("E1-c intended difference (SA-996), tier 1: OLD roundMoney(11.00 x 5/12) = 4.58 vs NEW roundMoney(5 x 0.92) = 4.60; print '5 pcs' vs '5 Piece'", () => {
    const old = oldFig(11);
    const next = newOwnFig(1);
    expectSame("E1-c tier1 (tax basis)", basis(old), basis(next));
    expect(old.subtotal).toBe(computeLineSubtotal({ unitPrice: 11, ...oldStored }));
    expect(next.subtotal).toBe(roundMoney(5 * 0.92));
    expect([old.subtotal, next.subtotal]).toEqual([4.58, 4.6]); // OBSERVED, matches SA-996 table
    expect([old.printedQty, next.printedQty]).toEqual(["5 pcs", "5 Piece"]);
  });
  it("E1-c intended difference (SA-996), tier 3: OLD roundMoney(10.00 x 5/12) = 4.17 vs NEW roundMoney(5 x 0.83) = 4.15", () => {
    const old = oldFig(10);
    const next = newOwnFig(3);
    expectSame("E1-c tier3 (tax basis)", basis(old), basis(next));
    expect(old.subtotal).toBe(computeLineSubtotal({ unitPrice: 10, ...oldStored }));
    expect(next.subtotal).toBe(roundMoney(5 * 0.83));
    expect([old.subtotal, next.subtotal]).toEqual([4.17, 4.15]); // OBSERVED, matches SA-996 table
    expect([old.printedQty, next.printedQty]).toEqual(["5 pcs", "5 Piece"]);
  });
  it("guard row, tier 5: P = 9.00 / 12 = 0.75 exactly, so subtotal 3.75 = 3.75 and the tax basis are expectSame (the rounding of P is the only cause)", () => {
    const OWN5: LadderUnit[] = [
      { label: "Piece", factorToBase: 1, price: "0.92", ...noTiers, priceTier5: "0.75" },
    ];
    expect(resolveUnitPrice(product, OWN5, "Piece", 5)).toBe(0.75);
    expect(9 / 12).toBe(0.75);
    const old = oldFig(9);
    const next = newOwnFig(5, OWN5);
    expectSame(
      "E1-c tier5 (subtotal, tax basis)",
      { subtotal: old.subtotal, ...basis(old) },
      { subtotal: next.subtotal, ...basis(next) },
    );
    expect(old.subtotal).toBe(3.75);
  });
  it("guard row, no cap at the pack price: 12 pieces own-priced at tier 1 plan mode 'unit' and bill 12 x 0.92 = 11.04, above the 11.00 pack", () => {
    const plan = planBaseBilling(product, OWN, 1, 12);
    expect(plan).toMatchObject({ mode: "unit", unitLabel: "Piece", unitPrice: 0.92, qty: 12 });
    expect((plan as { subtotal: number }).subtotal).toBe(roundMoney(12 * 0.92));
    expect((plan as { subtotal: number }).subtotal).toBe(11.04); // OBSERVED: SA-996 ruling 3, no cap
    expect(11.04).toBeGreaterThan(11);
  });
});
