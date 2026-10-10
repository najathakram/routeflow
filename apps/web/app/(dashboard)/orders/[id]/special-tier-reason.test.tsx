/**
 * #2696(c) SA-558b(4): the edit page asks for a reason exactly when the server would refuse —
 * `needsSpecialTierReason` is a thin call to @routeflow/pricing's `needsOverrideReason` with the
 * act's baseline (the stored price for an existing line, the tier price for an add / substitution).
 */
jest.mock("@/lib/api/product-units", () => ({ useProductUnits: () => ({ data: [] }) }));
jest.mock("@/lib/api/margin", () => ({ useMarginConfig: () => ({ data: undefined }) }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));

import { needsSpecialTierReason } from "./page";

const line = (o: Record<string, unknown> = {}) => ({ unitPrice: 8, originalUnitPrice: 8, ...o });

describe("#2696(c) edit page — needsSpecialTierReason", () => {
  it("red-first: a move inside the server's ½¢ band is no repricing — no reason asked", () => {
    expect(needsSpecialTierReason(line({ unitPrice: 8.004 }), true)).toBe(false);
  });

  it("a real change on a special line with no reason needs one", () => {
    expect(needsSpecialTierReason(line({ unitPrice: 7 }), true)).toBe(true);
  });

  it("a reason (typed, or the one on file seeded into overrideReason) satisfies it", () => {
    expect(needsSpecialTierReason(line({ unitPrice: 7, overrideReason: "bent" }), true)).toBe(
      false,
    );
  });

  it("a substitution's own baseline wins over the stored price", () => {
    const sub = line({ unitPrice: 5, originalUnitPrice: 8, reasonBaselinePrice: 5 });
    expect(needsSpecialTierReason(sub, true)).toBe(false);
  });

  it("never for a non-special, an unlisted line, or one with no baseline", () => {
    expect(needsSpecialTierReason(line({ unitPrice: 3 }), false)).toBe(false);
    expect(needsSpecialTierReason(line({ unitPrice: 3, isUnlisted: true }), true)).toBe(false);
    expect(needsSpecialTierReason({ unitPrice: 3 }, true)).toBe(false);
  });
});
