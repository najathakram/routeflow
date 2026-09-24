/**
 * B699 / B722 (REG-B699, REG-B722): a PO line is denominated in its OWN stored packSize; the live
 * catalog pack is only the fallback. A bill-raised line stores the bill's pack even when the catalog
 * product is not boxed, and re-splitting it at the live pack rewrote its exact total on a save that
 * never touched the lines (11,000.00 -> 11,000.40).
 */
import { buildUpdateItems, linesChanged, toEditLine } from "./purchase-orders-edit";
import { linePack, resolveStoredPOLineAmounts, type POItem } from "./purchase-orders-shared";

/** A bill-raised line: 1,000 cases of 12 at $11.00 a case, stored exactly. */
const billRaised: POItem = {
  id: "poi-1",
  productId: "prod-1",
  qtyOrdered: 12000,
  qtyReceived: 0,
  unitCost: 0.9167,
  totalCost: 11000,
  packSize: 12,
} as POItem;

describe("B699 / B722 — a PO line keeps its own stored pack", () => {
  it("linePack: the stored pack wins; the live pack is only the fallback", () => {
    expect(linePack({ packSize: 12 }, 0)).toBe(12);
    expect(linePack({ packSize: 12 }, 6)).toBe(12);
    expect(linePack({ packSize: null }, 6)).toBe(6);
    expect(linePack({ packSize: 1 }, 6)).toBe(6);
  });

  it("REG-B722: resolveStoredPOLineAmounts splits at the STORED pack, even when the catalog pack is 0", () => {
    expect(resolveStoredPOLineAmounts(billRaised, 0)).toMatchObject({
      packSize: 12,
      cases: 1000,
      loosePieces: 0,
      totalCost: 11000,
    });
  });

  it("REG-B699: a notes-only save of a bill-raised line sends its own case figures and changes nothing", () => {
    const live = () => 0; // the catalog product is not boxed
    const line = toEditLine(billRaised, 0);
    expect(line).toMatchObject({ boxes: "1000", pieces: "0", unitCost: "11" });

    const items = buildUpdateItems([line], live);
    expect(items).toEqual([
      expect.objectContaining({ id: "poi-1", packSize: 12, caseCost: 11, cases: 1000 }),
    ]);
    // The lines did not change, so the modal sends no line rewrite at all.
    expect(linesChanged({ items: [billRaised] }, items)).toBe(false);
  });

  it("PIN: the stored pack also wins over a DIFFERENT live pack (the product was repacked)", () => {
    const items = buildUpdateItems([toEditLine(billRaised, 6)], () => 6);
    expect(items[0]).toMatchObject({ packSize: 12, cases: 1000 });
    expect(linesChanged({ items: [billRaised] }, items)).toBe(false);
  });

  it("PIN: a NEW line (no stored pack) still uses the live pack", () => {
    const items = buildUpdateItems(
      [
        {
          productId: "prod-2",
          qty: "",
          boxes: "2",
          pieces: "0",
          unitCost: "10",
          received: 0,
          sku: null,
          packSize: null,
        } as never,
      ],
      () => 6,
    );
    expect(items[0]).toMatchObject({ packSize: 6, cases: 2, caseCost: 10 });
  });
});
