/**
 * B716 — B698's deferred FOURTH site — the vendor-bills page's own Purchase Orders ledger row (a page-local
 * `PurchaseOrdersTab`, not the inventory `_components` one the rest of B698 fixed). Its `poTotal`
 * fell back to `sum(qtyOrdered x unitCost)`, re-multiplying the 4 dp per-piece cost that B677
 * (#1199) made redundant by storing the exact total. Each pair below is the figure the server
 * stored vs the figure that product displayed for the same row.
 */
import { poTotal, type POLedgerItem } from "./po-ledger-total";

const naive = (it: POLedgerItem) => Number(it.qtyOrdered) * Number(it.unitCost);

/** [cases, packSize, caseCost] -> the stored line as the LIST endpoint returns it (Decimal strings). */
const storedLine = (cases: number, pack: number, caseCost: number): POLedgerItem => ({
  qtyOrdered: String(cases * pack),
  unitCost: (caseCost / pack).toFixed(4),
  totalCost: (cases * caseCost).toFixed(2),
});

const po = (over: Partial<Parameters<typeof poTotal>[0]>) => ({
  id: "po1",
  poNumber: "PO-0001",
  status: "SENT",
  ...over,
});

describe("poTotal — the line fallback reads the stored line totals (B716/B698)", () => {
  it.each([
    [1000, 12, 11, 11000.0, 11000.4],
    [300, 3, 10, 3000.0, 2999.97],
    [250, 24, 17, 4250.0, 4249.8],
  ])(
    "%i cases x %i at $%s with no order total: $%s, not the $%s of qtyOrdered x unitCost",
    (cases, pack, caseCost, exact, drifted) => {
      const line = storedLine(cases, pack, caseCost);
      expect(naive(line)).toBeCloseTo(drifted, 6); // what the ledger row showed before
      expect(poTotal(po({ items: [line] }))).toBe(exact);
    },
  );

  it("sums the STORED line totals across a multi-line PO, not the drifted products", () => {
    const items = [storedLine(1000, 12, 11), storedLine(300, 3, 10), storedLine(250, 24, 17)];
    expect(items.reduce((s, it) => s + naive(it), 0)).not.toBeCloseTo(18250, 6);
    expect(poTotal(po({ items }))).toBe(18250);
  });
});

describe("poTotal — the stored order total still wins (B716/B698)", () => {
  it("returns totalAmount whenever the row has one, ignoring the lines", () => {
    // Every PO `createPurchaseOrder` writes carries one; this is the ordinary path.
    expect(poTotal(po({ totalAmount: 11000, items: [storedLine(1000, 12, 11)] }))).toBe(11000);
  });

  it("prefers totalAmount even when it disagrees with the lines", () => {
    expect(poTotal(po({ totalAmount: 42.5, items: [storedLine(1000, 12, 11)] }))).toBe(42.5);
  });

  it("reads a stored zero rather than re-deriving it", () => {
    expect(poTotal(po({ totalAmount: 0, items: [storedLine(1000, 12, 11)] }))).toBe(0);
  });

  it("renders a stored NEGATIVE total as stored, never a derived sum on sign", () => {
    // Lead ruling (B716): sign is not a reason to disbelieve the stored money figure.
    expect(poTotal(po({ totalAmount: -250.75, items: [storedLine(1000, 12, 11)] }))).toBe(-250.75);
  });

  it("falls through to the lines only when the stored total is not a number at all", () => {
    // Better the stored line totals than rendering NaN.
    expect(poTotal(po({ totalAmount: NaN, items: [storedLine(1000, 12, 11)] }))).toBe(11000);
  });
});

describe("poTotal — rows with no stored total (B716/B698)", () => {
  it("falls back to roundMoney(qtyOrdered x unitCost) on a line that carries none", () => {
    expect(poTotal(po({ items: [{ qtyOrdered: "12000", unitCost: "0.9167" }] }))).toBe(11000.4);
    expect(
      poTotal(po({ items: [{ qtyOrdered: 3, unitCost: 0.3333, totalCost: undefined }] })),
    ).toBe(1);
    expect(poTotal(po({ items: [{ qtyOrdered: 3, unitCost: 0.3333, totalCost: "abc" }] }))).toBe(1);
  });

  it("is $0.00, never NaN, for a PO with no order total and no lines", () => {
    expect(poTotal(po({}))).toBe(0);
    expect(poTotal(po({ items: [] }))).toBe(0);
    expect(poTotal(po({ items: [{ qtyOrdered: "x", unitCost: "y" }] }))).toBe(0);
  });
});
