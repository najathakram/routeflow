import { normalizeReplayItems } from "./replay-cart-normalize";

/**
 * SA-1047: the replay compare sees a unit line that create() resolves to the PACK (the pack's own label, a Piece on a
 * pack-less product) as the pack line it is stored as: `unitLabel` null. A label create() cannot resolve is returned as
 * sent (it never throws here; create() refuses it as before). REAL resolveLineUnits, a fake db.
 */
const BOXED = { id: "p1", unit: "Box", unitsPerBox: 10, pricePerUnit: "2.50", isActive: true };
const LOOSE = { id: "p2", unit: "each", unitsPerBox: 1, pricePerUnit: "1.00", isActive: true };
const CASE = {
  productId: "p1",
  unitLabel: "Case",
  unitsPerBase: 200,
  isDefaultSelling: false,
  price: "45.00",
  isActive: true,
};

const fakeDb = (products: unknown[], units: unknown[] = []) => ({
  product: { findMany: jest.fn().mockResolvedValue(products) },
  productUnit: { findMany: jest.fn().mockResolvedValue(units) },
  customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: 1 }) },
  customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
});

describe("normalizeReplayItems: a unit line that resolves to the pack is compared as one", () => {
  it("the pack's own label comes back with unitLabel null; qty is kept", async () => {
    const out = await normalizeReplayItems(fakeDb([BOXED]), "c1", [
      { productId: "p1", unitLabel: "Box", qty: 2 },
    ]);
    expect(out).toEqual([{ productId: "p1", unitLabel: null, qty: 2 }]);
  });

  it("a real unit (a Case on the ladder) is left as sent", async () => {
    const out = await normalizeReplayItems(fakeDb([BOXED], [CASE]), "c1", [
      { productId: "p1", unitLabel: "Case", qty: 1 },
    ]);
    expect(out).toEqual([{ productId: "p1", unitLabel: "Case", qty: 1 }]);
  });

  it("G-c20: a label nothing resolves comes back exactly as sent, and nothing throws", async () => {
    const items = [{ productId: "p1", unitLabel: "Crate", qty: 1 }];
    const out = await normalizeReplayItems(fakeDb([BOXED]), "c1", items);
    expect(out).toEqual(items);
  });

  it("a pack-only cart costs no read and comes back as the same array", async () => {
    const db = fakeDb([LOOSE]);
    const items = [{ productId: "p2", qty: 3 }];
    expect(await normalizeReplayItems(db, "c1", items)).toBe(items);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});
