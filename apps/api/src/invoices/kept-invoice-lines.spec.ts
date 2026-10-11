import { splitKeptItems } from "./kept-invoice-lines";

/** B297 PR4 (R6): a rebuild keeps a line as the SAME InvoiceItem row when its ledger-relevant shape is unchanged. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "ii-1",
  orderItemId: "oi-1",
  productId: "p1",
  description: "Widget",
  qty: { toNumber: () => 12 }, // a Prisma Decimal
  unitPrice: "10.00",
  subtotal: "120.00",
  categoryTaxAmount: "0.60",
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  notes: null,
  ...over,
});
const data = (over: Record<string, unknown> = {}) => ({
  orderItemId: "oi-1",
  productId: "p1",
  description: "Widget",
  qty: 12,
  unitPrice: 10,
  subtotal: 120,
  categoryTaxAmount: 0.6,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  notes: null,
  ...over,
});

describe("splitKeptItems", () => {
  it("keeps an identical line as the same row, writing nothing", () => {
    const r = splitKeptItems([row()], [data()]);
    expect(r).toEqual({ keepIds: ["ii-1"], updates: [], create: [] });
  });

  it("keeps the row and writes a changed NON-ledger column in place (a note, a description)", () => {
    const d = data({ notes: "leave at the dock", description: "Widget 2" });
    const r = splitKeptItems([row()], [d]);
    expect(r.keepIds).toEqual(["ii-1"]);
    expect(r.updates).toEqual([{ id: "ii-1", data: d }]);
    expect(r.create).toEqual([]);
  });

  it.each([
    ["qty", { qty: 10 }],
    ["subtotal", { subtotal: 100 }],
    ["categoryTaxAmount", { categoryTaxAmount: 0.5 }],
    ["boxes", { boxes: 1 }],
    ["unitsPerBox", { unitsPerBox: 12 }],
    ["trackedCategoryId", { trackedCategoryId: "cat-2" }],
    ["productId", { productId: "p2" }],
  ])("re-creates a line whose %s changed", (_k, change) => {
    const d = data(change);
    const r = splitKeptItems([row()], [d]);
    expect(r).toEqual({ keepIds: [], updates: [], create: [d] });
  });

  it("matches on orderItemId, one row per line, and never keeps a line without provenance", () => {
    const r = splitKeptItems(
      [row(), row({ id: "ii-2", orderItemId: "oi-2" })],
      [data({ orderItemId: "oi-2" }), data({ orderItemId: null })],
    );
    expect(r.keepIds).toEqual(["ii-2"]);
    expect(r.create).toHaveLength(1);
  });

  it("never keeps a line with a nested write (composition components)", () => {
    const d = data({ components: { create: [{ name: "a" }] } });
    expect(splitKeptItems([row()], [d]).create).toEqual([d]);
  });

  it("does not compare against a stored row that was not loaded with the column", () => {
    const partial = { id: "ii-1", orderItemId: "oi-1", qty: 12 };
    expect(splitKeptItems([partial], [data()]).keepIds).toEqual([]);
  });

  it("treats null and undefined as the same empty value, and two Decimals by value", () => {
    const r = splitKeptItems([row({ notes: undefined })], [data({ notes: null })]);
    expect(r.keepIds).toEqual(["ii-1"]);
  });
});
