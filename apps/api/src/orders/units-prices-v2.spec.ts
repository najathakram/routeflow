/**
 * Units S19 (SA-796 / SA-799, flag.units_prices_v2): billing reads the customer's TYPED unit prices
 * (CustomerUnitPrice) and the one tier resolver. Precedence, flag on: typed > sticky history > tier > list.
 * Flag off, or no typed row: master's code path, untouched. Pure seams only; the wiring is pinned in
 * orders.units-prices-v2.spec.ts and the invoice specs.
 */
import { PriceType } from "@prisma/client";
import { resolveBuyerLinePrice } from "./buyer-merge-pricing";
import { decideTierOverride } from "./staff-override";
import { buildUnitLine } from "./unit-line-build";
import { loadUnitsPricesV2, typedPriceFor, UNITS_PRICES_V2_FLAG } from "./units-prices-v2";

const product = {
  id: "p1",
  name: "Widget",
  category: null,
  unit: "Box",
  unitsPerBox: 12,
  pricePerUnit: 120,
  priceTier2: 100,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};
const piece = {
  id: "u-piece",
  label: "Piece",
  factorToBase: 1,
  price: "11.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const case24 = { ...piece, id: "u-case", label: "Case", factorToBase: 24, price: "200.00" };

describe("loadUnitsPricesV2", () => {
  const rows = [
    { productId: "p1", unitRef: "pack", price: "99.50" },
    { productId: "p1", unitRef: "base", price: "9.25" },
  ];
  const deps = (hasFlag: unknown, findMany: unknown) =>
    ({
      entitlements: { hasFlag },
      db: { customerUnitPrice: { findMany } },
      tenantId: "t1",
    }) as never;

  it("flag on + typed rows: reads them by (customer, products) and keys them by level ref", async () => {
    const hasFlag = jest.fn().mockResolvedValue(true);
    const findMany = jest.fn().mockResolvedValue(rows);
    const v2 = await loadUnitsPricesV2(deps(hasFlag, findMany), "c1", ["p1", "p1", null]);
    expect(hasFlag).toHaveBeenCalledWith("t1", UNITS_PRICES_V2_FLAG);
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      customerId: "c1",
      productId: { in: ["p1"] },
    });
    expect(v2?.typedFor("p1")).toEqual({ pack: 99.5, base: 9.25 });
    expect(v2?.typedFor("other")).toBeUndefined();
  });

  it("flag off: null, even with typed rows (a revoked tenant bills as master)", async () => {
    const v2 = await loadUnitsPricesV2(
      deps(jest.fn().mockResolvedValue(false), jest.fn().mockResolvedValue(rows)),
      "c1",
      ["p1"],
    );
    expect(v2).toBeNull();
  });

  it("no typed row and ordinary tiers: the flag is never consulted (nothing could differ)", async () => {
    const hasFlag = jest.fn().mockResolvedValue(true);
    const v2 = await loadUnitsPricesV2(
      deps(hasFlag, jest.fn().mockResolvedValue([])),
      "c1",
      ["p1"],
      [1, null, 3],
    );
    expect(v2).toBeNull();
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("a junk tier is the one named difference (PF-14): the flag is asked, and customerTierFor decides", async () => {
    const hasFlag = jest.fn().mockResolvedValue(true);
    const v2 = await loadUnitsPricesV2(
      deps(hasFlag, jest.fn().mockResolvedValue([])),
      "c1",
      ["p1"],
      [9, 2],
    );
    expect(hasFlag).toHaveBeenCalledTimes(1);
    expect(v2?.tierOf(9, 2)).toBe(2);
    expect(v2?.tierOf(null, undefined)).toBe(1);
  });

  it("a client without the model still gets the tier rule; no customer or no tenant: null", async () => {
    const hasFlag = jest.fn().mockResolvedValue(true);
    expect(
      await loadUnitsPricesV2(
        { entitlements: { hasFlag }, db: {}, tenantId: "t1" } as never,
        "c1",
        ["p1"],
        [7],
      ),
    ).not.toBeNull();
    expect(await loadUnitsPricesV2(deps(hasFlag, jest.fn()), null, ["p1"])).toBeNull();
    expect(
      await loadUnitsPricesV2(
        { ...(deps(hasFlag, jest.fn()) as object), tenantId: null } as never,
        "c1",
        ["p1"],
      ),
    ).toBeNull();
  });
});

describe("typedPriceFor: the level ref of the line's unit (SA-809)", () => {
  const typed = { pack: 99.5, base: 9.25, "u-case": 190 };
  it("no unit label = the pack", () => {
    expect(typedPriceFor(typed, product, [piece, case24], null)).toBe(99.5);
  });
  it("the 1-piece row's ref is the level ref base, never its ProductUnit id", () => {
    expect(typedPriceFor(typed, product, [piece, case24], "Piece")).toBe(9.25);
    expect(typedPriceFor({ "u-piece": 1 }, product, [piece, case24], "Piece")).toBeNull();
  });
  it("SA-809: a customer with BOTH a base row and a legacy factor-1 id row bills the exact base row, never a sum or the id row", () => {
    const both = { base: 9.25, "u-piece": 7.5 };
    expect(typedPriceFor(both, product, [piece, case24], "Piece")).toBe(9.25);
    // and with only the legacy id row there is no base price (the write path canonicalizes ids to base)
    expect(typedPriceFor({ "u-piece": 7.5 }, product, [piece, case24], "Piece")).toBeNull();
  });
  it("another unit is its own ProductUnit id", () => {
    expect(typedPriceFor(typed, product, [piece, case24], "Case")).toBe(190);
  });
  it("no typed map, no row for that unit, or a unit the product lacks: null", () => {
    expect(typedPriceFor(undefined, product, [piece], null)).toBeNull();
    expect(typedPriceFor({ pack: 5 }, product, [piece, case24], "Case")).toBeNull();
    expect(typedPriceFor(typed, product, [piece], "Pallet")).toBeNull();
  });
});

describe("resolveBuyerLinePrice: typed pack price (precedence typed > history > tier > list)", () => {
  const args = (tier: number, remembered: number | null, typed?: number | null) =>
    resolveBuyerLinePrice(product, tier, [], 12, 1, remembered, undefined, typed);

  it("flag off / no typed price: byte-identical to master (tier, sticky upsell)", () => {
    expect(args(2, null)).toMatchObject({ unitPrice: 100, priceType: PriceType.SPECIAL });
    expect(args(1, 150)).toMatchObject({ unitPrice: 150, priceType: PriceType.MANUAL });
    expect(args(1, null, null)).toEqual(args(1, null));
  });
  it("a typed price beats the tier price and is the customer's SPECIAL price against list", () => {
    expect(args(2, null, 90)).toMatchObject({
      unitPrice: 90,
      originalPrice: 120,
      priceType: PriceType.SPECIAL,
    });
  });
  it("a typed price beats sticky history, above-list history included", () => {
    expect(args(1, 150, 90)).toMatchObject({ unitPrice: 90, priceType: PriceType.SPECIAL });
  });
  it("a typed price equal to list at tier 1 is a plain STANDARD line", () => {
    expect(args(1, null, 120)).toMatchObject({
      unitPrice: 120,
      originalPrice: null,
      priceType: PriceType.STANDARD,
    });
  });
});

describe("decideTierOverride: a typed price is the baseline a staff-typed price is judged against", () => {
  it("master: judged against the tier price (unchanged without a typed price)", () => {
    expect(decideTierOverride(product, 2, 100, null)).toMatchObject({ overridden: false });
    expect(() => decideTierOverride(product, 2, 95, null)).toThrow(/reason is required/);
  });
  it("typed 90: 90 is no override; 85 on a special price needs a reason", () => {
    expect(decideTierOverride(product, 1, 90, null, 90)).toMatchObject({ overridden: false });
    expect(() => decideTierOverride(product, 1, 85, null, 90)).toThrow(/reason is required/);
    expect(decideTierOverride(product, 1, 85, "promo", 90)).toMatchObject({ overridden: true });
  });
});

describe("buildUnitLine: a typed price for the line's unit wins over the tier price", () => {
  const taxFor = () => ({
    amount: 0,
    snapshot: { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null },
  });
  const build = (label: string, extra: Record<string, unknown> = {}) =>
    buildUnitLine({
      product,
      units: [piece, case24],
      resolved: { unitLabel: label, unitsPerBox: label === "Piece" ? 1 : 24 },
      item: { productId: "p1", qty: 2, unitLabel: label },
      tier: 2,
      taxFor,
      position: 0,
      tenantId: "t1",
      ...extra,
    } as never);

  it("flag off: the ladder price at the tier (identical to master)", () => {
    expect(build("Case")).toMatchObject({ unitPrice: 166.67, priceType: PriceType.SPECIAL });
    expect(build("Case", { customerUnitPrices: undefined })).toEqual(build("Case"));
  });
  it("typed Piece (base) and typed Case (ProductUnit id) each price their own unit", () => {
    const typed = { base: 9.25, "u-case": 190 };
    expect(build("Piece", { customerUnitPrices: typed })).toMatchObject({
      unitPrice: 9.25,
      subtotal: 18.5,
      priceType: PriceType.SPECIAL,
    });
    expect(build("Case", { customerUnitPrices: typed })).toMatchObject({
      unitPrice: 190,
      subtotal: 380,
    });
  });
  it("a typed price for another unit does not touch this one", () => {
    expect(build("Case", { customerUnitPrices: { base: 9.25 } })).toMatchObject({ unitPrice: 166.67 });
  });
});
