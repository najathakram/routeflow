import { resolveMsrp, wholesalePerPiece, isMsrpBelowWholesale, loadMsrpMap } from "./msrp";

/**
 * MSRP resolver regression suite. MSRP is display-only — it must NEVER feed money math
 * (computeLineSubtotal, totals, tax, margin, promotions) — so this suite is weighted toward
 * proving the "no MSRP" cases collapse to `null`, never `0`, and toward the precedence order
 * (customer override → future segment layer → product default) that every call site
 * (InvoiceItem snapshot, product/customer UI, loadMsrpMap) depends on.
 */
describe("msrp — resolveMsrp precedence", () => {
  it("customer override wins over the product default", () => {
    expect(resolveMsrp({ customerMsrp: 9.99, productMsrp: 4.99 })).toBe(9.99);
  });

  it("falls back to the product default when there is no customer override", () => {
    expect(resolveMsrp({ customerMsrp: null, productMsrp: 4.99 })).toBe(4.99);
    expect(resolveMsrp({ productMsrp: 4.99 })).toBe(4.99);
  });

  it("the (unused-in-v1) segment layer sits between customer and product", () => {
    expect(resolveMsrp({ customerMsrp: null, segmentMsrp: 6.5, productMsrp: 4.99 })).toBe(6.5);
    // Customer override still beats segment.
    expect(resolveMsrp({ customerMsrp: 9.99, segmentMsrp: 6.5, productMsrp: 4.99 })).toBe(9.99);
  });

  it("an invalid customer override (0, negative, NaN) is skipped, not treated as a real value — falls through to segment/product", () => {
    expect(resolveMsrp({ customerMsrp: 0, productMsrp: 4.99 })).toBe(4.99);
    expect(resolveMsrp({ customerMsrp: -5, productMsrp: 4.99 })).toBe(4.99);
    expect(resolveMsrp({ customerMsrp: NaN, productMsrp: 4.99 })).toBe(4.99);
  });

  it("returns null, never 0, when nothing resolves at any level", () => {
    expect(resolveMsrp({})).toBeNull();
    expect(resolveMsrp({ customerMsrp: null, segmentMsrp: undefined, productMsrp: null })).toBe(
      null,
    );
    expect(resolveMsrp({ customerMsrp: 0, segmentMsrp: 0, productMsrp: 0 })).toBeNull();
  });

  describe("every level normalizes 0 / negative / NaN / empty-string / missing to null", () => {
    it.each([
      ["zero", 0],
      ["negative", -1.5],
      ["NaN", NaN],
      ["empty string", ""],
      ["null", null],
      ["undefined", undefined],
      ["non-numeric string", "not-a-number"],
    ])("%s productMsrp resolves to null", (_label, bad) => {
      expect(resolveMsrp({ productMsrp: bad })).toBeNull();
    });
  });

  it("rounds to the cent, same half-up convention as roundMoney", () => {
    expect(resolveMsrp({ productMsrp: 4.005 })).toBe(4.01);
    expect(resolveMsrp({ productMsrp: 2.675 })).toBe(2.68);
  });

  it("accepts numeric strings and Decimal-like values (Number() coercion)", () => {
    expect(resolveMsrp({ productMsrp: "4.99" })).toBe(4.99);
  });
});

describe("msrp — wholesalePerPiece", () => {
  it("boxed product: divides pricePerUnit (per box) by unitsPerBox", () => {
    expect(wholesalePerPiece(24, 12)).toBe(2);
    expect(wholesalePerPiece(35, 12)).toBe(2.92); // 2.9166... rounds to 2.92
  });

  it("loose product: unitsPerBox absent, 1, or 0 — price already per piece, returned unchanged", () => {
    expect(wholesalePerPiece(4.5)).toBe(4.5);
    expect(wholesalePerPiece(4.5, 1)).toBe(4.5);
    expect(wholesalePerPiece(4.5, 0)).toBe(4.5);
    expect(wholesalePerPiece(4.5, null)).toBe(4.5);
  });

  it("invalid or non-positive pricePerUnit returns null, never 0 or NaN", () => {
    expect(wholesalePerPiece(0)).toBeNull();
    expect(wholesalePerPiece(-5)).toBeNull();
    expect(wholesalePerPiece(NaN)).toBeNull();
    expect(wholesalePerPiece(null)).toBeNull();
    expect(wholesalePerPiece(undefined)).toBeNull();
  });

  it("accepts numeric strings (Decimal-like) for both arguments", () => {
    expect(wholesalePerPiece("24", "12")).toBe(2);
  });
});

describe("msrp — isMsrpBelowWholesale (advisory only, never blocks)", () => {
  it("true when MSRP undercuts the per-piece wholesale price", () => {
    expect(isMsrpBelowWholesale(1.5, 24, 12)).toBe(true); // wholesale/pc = 2
  });

  it("false when MSRP is at or above the per-piece wholesale price", () => {
    expect(isMsrpBelowWholesale(2, 24, 12)).toBe(false); // equal, not below
    expect(isMsrpBelowWholesale(5, 24, 12)).toBe(false);
  });

  it("false (never a false positive) when either side fails to normalize", () => {
    expect(isMsrpBelowWholesale(null, 24, 12)).toBe(false);
    expect(isMsrpBelowWholesale(0, 24, 12)).toBe(false);
    expect(isMsrpBelowWholesale(1.5, 0, 12)).toBe(false);
    expect(isMsrpBelowWholesale(1.5, null)).toBe(false);
  });

  it("works for loose (non-boxed) products too", () => {
    expect(isMsrpBelowWholesale(3, 4.5)).toBe(true);
    expect(isMsrpBelowWholesale(6, 4.5)).toBe(false);
  });
});

describe("msrp — loadMsrpMap", () => {
  const makeDb = (products: any[], overrides: any[]) => ({
    product: { findMany: jest.fn().mockResolvedValue(products) },
    customerPrice: { findMany: jest.fn().mockResolvedValue(overrides) },
  });

  it("returns an empty map without querying when productIds is empty", async () => {
    const db = makeDb([], []);
    const result = await loadMsrpMap(db as any, "cust-1", []);
    expect(result.size).toBe(0);
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.customerPrice.findMany).not.toHaveBeenCalled();
  });

  it("resolves each product's MSRP, preferring the customer override when present", async () => {
    const db = makeDb(
      [
        { id: "p1", msrp: 4.99 },
        { id: "p2", msrp: 9.99 },
      ],
      [{ productId: "p1", msrp: 7.5 }],
    );
    const result = await loadMsrpMap(db as any, "cust-1", ["p1", "p2"]);
    expect(result.get("p1")).toBe(7.5); // override wins
    expect(result.get("p2")).toBe(9.99); // falls back to product default
  });

  it("a product with no MSRP anywhere resolves to null, not 0 or undefined", async () => {
    const db = makeDb([{ id: "p1", msrp: null }], []);
    const result = await loadMsrpMap(db as any, "cust-1", ["p1"]);
    expect(result.get("p1")).toBeNull();
  });

  it("scopes the override lookup to the given customer and product ids", async () => {
    const db = makeDb([{ id: "p1", msrp: 4.99 }], []);
    await loadMsrpMap(db as any, "cust-1", ["p1"]);
    expect(db.customerPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "cust-1", productId: { in: ["p1"] } },
      }),
    );
  });
});
