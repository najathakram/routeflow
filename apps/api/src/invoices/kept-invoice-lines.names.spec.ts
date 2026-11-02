import { rebuildKeptItems, splitKeptItems } from "./kept-invoice-lines";
import { LINE_NAME_PRODUCT_SELECT } from "./invoice-line-name";

/**
 * SA-1081 (#4098): once the order reads load the family (F1), a rebuild builds "<Family> - <Variant>" for every variant
 * line. A KEPT row whose stored text is only the bare form of that must keep its stored text: rewriting it would show an
 * untouched sent invoice as changed since sent. Rows FN-1 to FN-5 of the ruling.
 */
const FAMILY = "Acme Family";
const COMPOSED = `${FAMILY} - Classic`;
const product = {
  name: "Classic",
  variantName: "Classic",
  parentProductId: "p-family",
  parent: { name: FAMILY },
};

/** One stored line with every ledger-relevant column present (a rebuild compares them). */
const stored = (description: string, over: Record<string, unknown> = {}) => ({
  id: "row-1",
  orderItemId: "oi-1",
  productId: "p-variant",
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  qty: 12,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  subtotal: 96,
  categoryTaxAmount: 0,
  description,
  product,
  ...over,
});
/** What the rebuild builds for the same order line today: the composed name, the same money. */
const built = (over: Record<string, unknown> = {}) => {
  const { product: _p, id: _i, ...row } = stored(COMPOSED);
  return { ...row, ...over };
};

describe("SA-1081 keep rule: a rebuild keeps a stored bare name", () => {
  it("FN-1: an old bare line, nothing changed: kept in place, no write", () => {
    const out = splitKeptItems([stored("Classic")], [built()]);
    expect(out.keepIds).toEqual(["row-1"]);
    expect(out.updates).toEqual([]);
    expect(out.create).toEqual([]);
  });

  it("FN-3: a stored composed line, nothing changed: kept, no write", () => {
    const out = splitKeptItems([stored(COMPOSED)], [built()]);
    expect(out.keepIds).toEqual(["row-1"]);
    expect(out.updates).toEqual([]);
  });

  it("FN-5: stored typed text on a rebuild is written, as before", () => {
    const out = splitKeptItems([stored("Classic, gift")], [built()]);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0].data.description).toBe(COMPOSED);
  });

  it("another column that changed still writes, and the bare name is kept inside that write", () => {
    const out = splitKeptItems([stored("Classic", { notes: "old" })], [built({ notes: "new" })]);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0].data).toMatchObject({ notes: "new", description: "Classic" });
  });
});

describe("SA-1081 through rebuildKeptItems (the draft rebuild's item step)", () => {
  const db = (rows: any[]) => ({
    invoiceItem: {
      findMany: jest.fn().mockResolvedValue(rows),
      deleteMany: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  });

  it("reads each row's product with the name fields", async () => {
    const d = db([stored("Classic")]);
    await rebuildKeptItems(d, "inv-1", [], [built()]);
    expect(d.invoiceItem.findMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1" },
      include: { product: { select: LINE_NAME_PRODUCT_SELECT } },
    });
  });

  it("FN-2: an old bare line on an invoice nobody edited is neither deleted nor rewritten", async () => {
    const d = db([stored("Classic")]);
    const create = await rebuildKeptItems(d, "inv-1", [], [built()]);
    expect(create).toEqual([]);
    expect(d.invoiceItem.update).not.toHaveBeenCalled();
    expect(d.invoiceItem.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1", id: { notIn: ["row-1"] } },
    });
  });

  it("FN-4: an old bare line whose qty changes is re-created composed (a new row, one reversal and sale)", async () => {
    const d = db([stored("Classic")]);
    const create = await rebuildKeptItems(d, "inv-1", [], [built({ qty: 6, subtotal: 48 })]);
    expect(create).toHaveLength(1);
    expect(create[0].description).toBe(COMPOSED);
    expect(d.invoiceItem.update).not.toHaveBeenCalled();
    expect(d.invoiceItem.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1", id: { notIn: [] } },
    });
  });
});
