/**
 * B698 — the PO detail screen renders the STORED exact line total, never qtyOrdered x the 4 dp
 * per-piece cost (the display side of the B677 / #1199 PO-totals family). Each pair below is the
 * figure the server stored vs the figure the old multiply displayed for the same row.
 */
import { poLineSubtotal } from "../lib/po-line-subtotal";
import { poDisplayTotal } from "../lib/po-list-logic";

const naive = (it: { qtyOrdered: string; unitCost: string }) =>
  Number(it.qtyOrdered) * Number(it.unitCost);

// [cases, packSize, caseCost] -> the stored row as the API returns it (Decimal strings)
const stored = (cases: number, pack: number, caseCost: number) => ({
  qtyOrdered: String(cases * pack),
  unitCost: (caseCost / pack).toFixed(4),
  totalCost: (cases * caseCost).toFixed(2),
  packSize: pack,
});

describe("poLineSubtotal (B698)", () => {
  it.each([
    [1000, 12, 11, 11000.0, 11000.4],
    [300, 3, 10, 3000.0, 2999.97],
    [250, 24, 17, 4250.0, 4249.8],
  ])(
    "%i cases x %i at $%s: stored $%s, not the $%s of qtyOrdered x unitCost",
    (cases, pack, caseCost, exact, drifted) => {
      const row = stored(cases, pack, caseCost);
      expect(naive(row)).toBeCloseTo(drifted, 6); // what the screen showed before
      expect(poLineSubtotal(row)).toBe(exact);
    },
  );

  it("falls back to roundMoney(qtyOrdered x unitCost) only when there is no stored total", () => {
    expect(poLineSubtotal({ qtyOrdered: "12000", unitCost: "0.9167" })).toBe(11000.4);
    expect(poLineSubtotal({ qtyOrdered: "3", unitCost: "0.3333", totalCost: null })).toBe(1);
    expect(poLineSubtotal({ qtyOrdered: "3", unitCost: "0.3333", totalCost: "abc" })).toBe(1);
  });

  it("never returns NaN", () => {
    expect(poLineSubtotal({ qtyOrdered: "x", unitCost: "y" })).toBe(0);
  });
});

describe("poDisplayTotal — the one order-total derivation (B698)", () => {
  const items = [stored(1000, 12, 11), stored(300, 3, 10), stored(250, 24, 17)];

  it("header and rows agree on the stored figures on one screen", () => {
    const total = poDisplayTotal({ totalAmount: "18250.00", items });
    expect(total).toBe(18250);
    expect(items.reduce((s, it) => s + poLineSubtotal(it), 0)).toBe(total);
  });

  it("with no stored totalAmount it sums the STORED line totals, not the drifted products", () => {
    expect(poDisplayTotal({ totalAmount: null, items })).toBe(18250);
    expect(items.reduce((s, it) => s + naive(it), 0)).not.toBe(18250);
  });
});
