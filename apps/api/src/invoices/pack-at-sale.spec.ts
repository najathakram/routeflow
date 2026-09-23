import { Logger } from "@nestjs/common";
import { regulatedUnitBasis } from "@routeflow/pricing";
import { packAtSaleByProduct, toSaleLedgerLines } from "./pack-at-sale";

describe("packAtSaleByProduct", () => {
  it("maps productId -> the live product's unitsPerBox", async () => {
    const db = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", unitsPerBox: 24 }]) },
    };
    const map = await packAtSaleByProduct(db, [{ productId: "p1" }]);
    expect(map.get("p1")).toBe(24);
  });

  it("skips the query and returns empty with no product ids", async () => {
    const db = { product: { findMany: jest.fn() } };
    const map = await packAtSaleByProduct(db, [{ productId: null }]);
    expect(map.size).toBe(0);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});

describe("toSaleLedgerLines — packAtSale (B700: the line's own snapshot wins over the live product)", () => {
  // B700's own repro: an order line snapshotted `unitsPerBox: 12` at sale time, then the
  // product gets repacked to 24 before this line is ever re-processed (a resync, or a second
  // read of the same fetched items). A box-unaware qty-5 line must book 60 pieces off the
  // SNAPSHOT (5 * 12), never 120 off the live pack (5 * 24) — proven by feeding the real
  // `regulatedUnitBasis` the exact `packAtSale` this function produced, not asserting the
  // multiplication ourselves.
  const boxUnawareLine = (unitsPerBox: number | null) => ({
    id: "ii1",
    productId: "p1",
    qty: 5,
    boxes: null,
    pieces: null,
    unitLabel: null,
    unitsPerBox,
    subtotal: 50,
    categoryTaxAmount: 0,
  });

  it("CREATE-path shape: snapshot 12, live repacked to 24 — packAtSale is 12, books 60 not 120", () => {
    const packMap = new Map([["p1", 24]]);
    const [line] = toSaleLedgerLines([boxUnawareLine(12)], packMap);
    expect(line.packAtSale).toBe(12);
    expect(regulatedUnitBasis(line, line.packAtSale).unitBasisQty).toBe(60);
  });

  it("RESYNC-path shape (items re-fetched fresh, packMap re-read fresh): same snapshot still wins — 12, books 60 not 120", () => {
    // resyncInvoiceLedger calls packAtSaleByProduct and toSaleLedgerLines fresh on every
    // re-sync; a fresh live-pack read of 24 must still lose to the item's own stored snapshot.
    const packMap = new Map([["p1", 24]]);
    const [line] = toSaleLedgerLines([boxUnawareLine(12)], packMap);
    expect(line.packAtSale).toBe(12);
    expect(regulatedUnitBasis(line, line.packAtSale).unitBasisQty).toBe(60);
  });

  it("no snapshot (manual/freeform line, unitsPerBox null): falls back to the live product — still books 60", () => {
    const packMap = new Map([["p1", 12]]);
    const [line] = toSaleLedgerLines([boxUnawareLine(null)], packMap);
    expect(line.packAtSale).toBe(12);
    expect(regulatedUnitBasis(line, line.packAtSale).unitBasisQty).toBe(60);
  });

  it("neither a snapshot nor a live product found (deleted product): packAtSale is null", () => {
    const packMap = new Map<string, number>();
    const [line] = toSaleLedgerLines([boxUnawareLine(null)], packMap);
    expect(line.packAtSale).toBeNull();
  });

  it("warns with the invoiceItemId and both packs when the snapshot and the live product disagree", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const packMap = new Map([["p1", 24]]);
    toSaleLedgerLines([boxUnawareLine(12)], packMap);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ii1"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("12"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("24"));
    warnSpy.mockRestore();
  });

  it("does NOT warn when the snapshot and the live product agree", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const packMap = new Map([["p1", 12]]);
    toSaleLedgerLines([boxUnawareLine(12)], packMap);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does NOT warn when only one of the two packs exists (nothing to compare)", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    toSaleLedgerLines([boxUnawareLine(null)], new Map([["p1", 24]]));
    toSaleLedgerLines([boxUnawareLine(12)], new Map());
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
