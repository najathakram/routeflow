import { readFileSync } from "fs";
import { join } from "path";
import {
  addCatalogItem,
  buyerSavePlan,
  hydrateBuyerDraft,
  setDraftQty,
  type BuyerOrderLineLike,
} from "../lib/buyer-edit-items";

/**
 * SA-1118 / SA-1131 R-4 (guard): the mobile buyer editor's full state sequence, step a named box-split row to 0
 * then add the same product from the catalog, leaves one row with no line id and qty 1, and Save sends it as an
 * unnamed bare count. The server reads that as the pack under `namesLines: true` (SA-601, SA-1118 R-1).
 * Green on master; pinned. Placeholders only.
 */
const BOXED: BuyerOrderLineLike = {
  id: "li-1",
  productId: "p-1",
  qty: 24,
  unitPrice: 4,
  boxes: 2,
  unitsPerBox: 12,
  status: "PENDING",
  product: { name: "Sample Cola 12oz", unit: "case" },
};
const CATALOG = { id: "p-1", name: "Sample Cola 12oz", unit: "case", buyerPrice: 48 };

describe("mobile buyer editor remove then re-add (SA-1131 R-4)", () => {
  it("R-4: stepping a named row to 0 then adding the product leaves one row, no line id, qty 1", () => {
    const opened = hydrateBuyerDraft([BOXED]);
    expect(Object.values(opened)).toEqual([
      expect.objectContaining({ orderItemId: "li-1", qty: 24 }),
    ]);

    const removed = setDraftQty(opened, "li-1", 0);
    expect(removed).toEqual({});

    const readded = addCatalogItem(removed, CATALOG);
    const rows = Object.values(readded);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("orderItemId");
    expect(rows[0]).toMatchObject({ productId: "p-1", qty: 1, unitPrice: 48 });

    expect(buyerSavePlan([BOXED], readded)).toEqual({
      kind: "replace",
      items: [{ productId: "p-1", qty: 1 }],
    });
  });

  it("while the row is still in the draft, adding the product is +1 to that named row", () => {
    const opened = hydrateBuyerDraft([BOXED]);
    expect(addCatalogItem(opened, CATALOG)).toEqual({
      "li-1": expect.objectContaining({ orderItemId: "li-1", qty: 25 }),
    });
  });

  it("the screen's stepper and catalog add go through these helpers", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/(customer)/orders/[id]/edit-items.tsx"),
      "utf8",
    );
    expect(src).toMatch(/setDraft\(\(d\) => setDraftQty\(d, key, qty\)\)/);
    expect(src).toMatch(/setDraft\(\(d\) => addCatalogItem\(d, p\)\)/);
  });
});
