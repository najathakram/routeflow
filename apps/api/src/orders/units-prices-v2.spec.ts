/**
 * Units S19 (SA-796 / SA-799 / SA-811 / SA-811a, flag.units_prices_v2): billing prices through ONE resolver, the customer
 * layer of the ladder (customerLayerPrice over resolveCustomerUnitPrice): a typed price, or one worked out from the typed
 * price on the customer's order unit. Precedence flag on: customer layer > sticky above-list > tier > list; above the unit's
 * Retail ladder price the layer is priced like the sticky upsell (MANUAL, no promo). Flag off, or the unit not in the layer:
 * master's code path, untouched. Pure seams only; the wiring is pinned in orders.units-prices-v2.spec.ts and the others.
 */
import { ServiceUnavailableException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resolveBuyerLinePrice } from "./buyer-merge-pricing";
import { decideTierOverride } from "./staff-override";
import { buildUnitLine } from "./unit-line-build";
import {
  customerPricing,
  loadUnitsPricesV2,
  omitCustomerLayerHistory,
  UNITS_PRICES_V2_FLAG,
} from "./units-prices-v2";

// Fixture (SA-811a): pack list $42 (a 24-piece Box), Case of 288 at $480, Piece (1) at $1.75.
const product = {
  id: "p1",
  name: "Widget",
  category: null,
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: 42,
  priceTier2: 40,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  orderUnitRef: "pack",
  packAuto: 0,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};
const noTiers = { priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null };
const piece = {
  id: "u-piece",
  productId: "p1",
  label: "Piece",
  factorToBase: 1,
  price: "1.75",
  ...noTiers,
};
const case288 = {
  id: "u-case",
  productId: "p1",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  ...noTiers,
};

type Rows = Array<[string, number]>;
const deps = (opts: { rows?: Rows; flag?: boolean | Error; units?: unknown[] }) => {
  const hasFlag = jest.fn(async () => {
    if (opts.flag instanceof Error) throw opts.flag;
    return opts.flag ?? true;
  });
  const db = {
    customerUnitPrice: {
      findMany: jest.fn().mockResolvedValue(
        (opts.rows ?? []).map(([unitRef, price]) => ({
          productId: "p1",
          unitRef,
          price: String(price),
        })),
      ),
    },
    productUnit: { findMany: jest.fn().mockResolvedValue(opts.units ?? [piece, case288]) },
    productTierUnit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { hasFlag, db, d: { entitlements: { hasFlag }, db, tenantId: "t1" } as never };
};
const svcOf = (h: ReturnType<typeof deps>) =>
  ({
    prisma: {
      forTenant: () => ({
        ...h.db,
        customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
      }),
      getTenantId: () => "t1",
    },
    entitlements: { hasFlag: h.hasFlag },
  }) as never;

describe("loadUnitsPricesV2", () => {
  it("flag on + typed rows: reads them by (customer, products), the ladder of those products, and asks the flag", async () => {
    const h = deps({ rows: [["pack", 33]] });
    const v2 = await loadUnitsPricesV2(h.d, "c1", ["p1", "p1", null]);
    expect(h.hasFlag).toHaveBeenCalledWith("t1", UNITS_PRICES_V2_FLAG);
    expect(h.db.customerUnitPrice.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      customerId: "c1",
      productId: { in: ["p1"] },
    });
    expect(v2).not.toBeNull();
    expect(h.db.productUnit.findMany).toHaveBeenCalledTimes(1);
    // nit 1: the ladder is read in the endpoint's order (sortOrder, then factor), so a case-colliding label picks the same unit
    expect(h.db.productUnit.findMany.mock.calls[0][0].orderBy).toEqual([
      { sortOrder: "asc" },
      { factorToBase: "asc" },
    ]);
    // nit 1: both ladder reads carry an explicit tenantId
    expect(h.db.productUnit.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      productId: { in: ["p1"] },
    });
    expect(h.db.productTierUnit.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      productId: { in: ["p1"] },
    });
  });

  it("flag off: null, even with typed rows (a revoked tenant bills as master)", async () => {
    expect(
      await loadUnitsPricesV2(deps({ rows: [["pack", 33]], flag: false }).d, "c1", ["p1"]),
    ).toBeNull();
  });

  // SA-812a G-1: a customer WITH typed rows is owed their typed price. A transient entitlement read error must never
  // quietly bill them the tier price on a server-priced path: it is a coded, retryable 503 and nothing is written.
  it("G-1: typed rows + a failed flag read throws a coded retryable 503 (never master's tier price)", async () => {
    const h = deps({ rows: [["pack", 33]], flag: new Error("entitlements down") });
    const err = await loadUnitsPricesV2(h.d, "c1", ["p1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      code: API_ERROR_CODES.CUSTOMER_PRICES_UNAVAILABLE,
    });
    // it fails before the ladder is read: nothing downstream ran
    expect(h.db.productUnit.findMany).not.toHaveBeenCalled();
  });

  it("G-1 guard: NO typed rows (only an odd tier) + a failed flag read keeps the master fallback", async () => {
    const h = deps({ flag: new Error("entitlements down") });
    await expect(loadUnitsPricesV2(h.d, "c1", ["p1"], [9, 2])).resolves.toBeNull();
    expect(h.hasFlag).toHaveBeenCalledTimes(1);
  });

  it("G-1 guard: a DENIED or revoked flag (a clean false) still prices as master, even with typed rows", async () => {
    const h = deps({ rows: [["pack", 33]], flag: false });
    await expect(loadUnitsPricesV2(h.d, "c1", ["p1"])).resolves.toBeNull();
    expect(h.hasFlag).toHaveBeenCalledTimes(1);
  });

  it("no typed row and ordinary tiers: the flag is never consulted (nothing could differ)", async () => {
    const h = deps({});
    expect(await loadUnitsPricesV2(h.d, "c1", ["p1"], [1, null, 3])).toBeNull();
    expect(h.hasFlag).not.toHaveBeenCalled();
  });

  it("a junk tier is the one named difference (PF-14): the flag is asked, and customerTierFor decides", async () => {
    const h = deps({});
    const v2 = await loadUnitsPricesV2(h.d, "c1", ["p1"], [9, 2]);
    expect(h.hasFlag).toHaveBeenCalledTimes(1);
    expect(v2?.tierOf(9, 2)).toBe(2);
    expect(v2?.tierOf(null, undefined)).toBe(1);
  });

  it("a client without the model still gets the tier rule; no customer or no tenant: null", async () => {
    const hasFlag = jest.fn().mockResolvedValue(true);
    expect(
      await loadUnitsPricesV2(
        { entitlements: { hasFlag }, db: {}, tenantId: "t1" },
        "c1",
        ["p1"],
        [7],
      ),
    ).not.toBeNull();
    expect(await loadUnitsPricesV2(deps({}).d, null, ["p1"])).toBeNull();
    expect(
      await loadUnitsPricesV2({ entitlements: { hasFlag }, db: {}, tenantId: null }, "c1", ["p1"]),
    ).toBeNull();
  });
});

describe("customerPricing.layer: ONE resolver (SA-811a R1)", () => {
  const layerOf = async (
    rows: Rows,
    label: string | null,
    extra: { orderUnitRef?: string; tier?: number } = {},
  ) => {
    const h = deps({ rows });
    const pc = await customerPricing(
      svcOf(h),
      "c1",
      ["p1"],
      { pricingTier: extra.tier ?? 1 },
      [{ productId: "p1", pricingTier: null, orderUnitRef: extra.orderUnitRef }],
      h.db,
    );
    return pc.layer(product, label);
  };

  it("R1a: typed pack $33 puts the Case in the customer's shape: 480 x 33/42 = $377.14 (customer-shape)", async () => {
    expect(await layerOf([["pack", 33]], "Case")).toMatchObject({
      price: 377.14,
      source: "customer-shape",
      listPrice: 480,
    });
  });
  it("R1b: typed Case $450 on the customer's order unit gives the pack 42 x 450/480 = $39.38", async () => {
    expect(await layerOf([["u-case", 450]], null, { orderUnitRef: "u-case" })).toMatchObject({
      price: 39.38,
      source: "customer-shape",
    });
  });
  it("typed pack: the pack itself is the typed price (customer)", async () => {
    expect(await layerOf([["pack", 33]], null)).toMatchObject({
      price: 33,
      source: "customer",
      listPrice: 42,
    });
  });
  it("the 1-piece row's typed price is the level ref base, never its ProductUnit id (SA-809: the exact base row wins)", async () => {
    expect(
      await layerOf(
        [
          ["base", 1.5],
          ["u-piece", 1.2],
        ],
        "Piece",
      ),
    ).toMatchObject({ price: 1.5, source: "customer" });
    // only the legacy id row: no base price; the pack has no typed price either, so not in the layer
    expect(await layerOf([["u-piece", 1.2]], "Piece")).toBeNull();
  });
  it("S19-b: a typed Case price only leaves the PACK out of the layer (sticky still runs), the Case is in it", async () => {
    expect(await layerOf([["u-case", 450]], null)).toBeNull();
    expect(await layerOf([["u-case", 450]], "Case")).toMatchObject({
      price: 450,
      source: "customer",
    });
  });
  it("flag off: never a layer", async () => {
    const h = deps({ rows: [["pack", 33]], flag: false });
    const pc = await customerPricing(svcOf(h), "c1", ["p1"], { pricingTier: 1 }, [], h.db);
    expect(pc.layer(product, null)).toBeNull();
    expect(pc.layered).toBe(false);
  });
});

describe("resolveBuyerLinePrice: the pack's customer layer (layer > sticky > tier > list; R2 above-list is MANUAL)", () => {
  const layer = (price: number, listPrice = 42) => ({
    unit: "pack",
    price,
    listPrice,
    source: "customer" as const,
    aboveList: price > listPrice,
  });
  const percent10 = {
    id: "pr",
    type: "PERCENT" as const,
    value: 10,
    minQty: null,
    scope: "ALL" as const,
    category: null,
    productIds: [],
  };
  const args = (
    tier: number,
    remembered: number | null,
    l?: ReturnType<typeof layer> | null,
    promos: any[] = [],
  ) => resolveBuyerLinePrice(product, tier, promos, 24, 1, remembered, undefined, l);

  it("flag off / no layer: byte-identical to master (tier, sticky upsell)", () => {
    expect(args(2, null)).toMatchObject({ unitPrice: 40, priceType: PriceType.SPECIAL });
    expect(args(1, 50)).toMatchObject({ unitPrice: 50, priceType: PriceType.MANUAL });
    expect(args(1, null, null)).toEqual(args(1, null));
  });
  it("S19-a: typed $33 beats a remembered above-list $50: $33 SPECIAL; flag off it is the $50 MANUAL (guard)", () => {
    expect(args(1, 50, layer(33))).toMatchObject({
      unitPrice: 33,
      originalPrice: 42,
      priceType: PriceType.SPECIAL,
    });
    expect(args(1, 50)).toMatchObject({ unitPrice: 50, priceType: PriceType.MANUAL });
  });
  it("S19-c: a 10% promo on a typed $33: $29.70 PROMO with $33 struck through; the layer price is never edited", () => {
    const l = layer(33);
    expect(args(1, null, l, [percent10])).toMatchObject({
      unitPrice: 29.7,
      originalPrice: 33,
      priceType: PriceType.PROMO,
    });
    expect(l.price).toBe(33);
  });
  it("R2a: a layer price above the unit's Retail ladder price ($45 over $42) is MANUAL with no promo, original = list", () => {
    expect(args(1, null, layer(45), [percent10])).toMatchObject({
      unitPrice: 45,
      originalPrice: 42,
      priceType: PriceType.MANUAL,
      freeUnits: 0,
    });
  });
  it("at list on tier 1 a layer price is a plain STANDARD line (promo-eligible)", () => {
    expect(args(1, null, layer(42))).toMatchObject({
      unitPrice: 42,
      originalPrice: null,
      priceType: PriceType.STANDARD,
    });
  });
});

describe("decideTierOverride: the layer price is the baseline a staff-typed price is judged against", () => {
  const layer = {
    unit: "pack",
    price: 33,
    listPrice: 42,
    source: "customer" as const,
    aboveList: false,
  };
  it("master: judged against the tier price (unchanged without a layer)", () => {
    expect(decideTierOverride(product, 2, 40, null)).toMatchObject({ overridden: false });
    expect(() => decideTierOverride(product, 2, 38, null)).toThrow(/reason is required/);
  });
  it("layer 33: 33 is no override; 30 on a special price needs a reason", () => {
    expect(decideTierOverride(product, 1, 33, null, layer)).toMatchObject({
      overridden: false,
      priceType: "SPECIAL",
    });
    expect(() => decideTierOverride(product, 1, 30, null, layer)).toThrow(/reason is required/);
    expect(decideTierOverride(product, 1, 30, "volume", layer)).toMatchObject({ overridden: true });
  });
  it("R2: an above-list layer echoed back is MANUAL but not a staff override", () => {
    expect(
      decideTierOverride(product, 1, 45, null, { ...layer, price: 45, aboveList: true }),
    ).toMatchObject({ priceType: "MANUAL", originalPrice: 42, overridden: false });
  });
});

describe("buildUnitLine: a unit in the customer layer wins over the ladder's tier price", () => {
  const taxFor = () => ({
    amount: 0,
    snapshot: { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null },
  });
  const build = (label: string, extra: Record<string, unknown> = {}) =>
    buildUnitLine({
      product,
      units: [piece, case288],
      resolved: { unitLabel: label, unitsPerBox: label === "Piece" ? 1 : 288 },
      item: { productId: "p1", qty: 2, unitLabel: label },
      tier: 1,
      taxFor,
      position: 0,
      tenantId: "t1",
      overriddenBy: "staff-1",
      ...extra,
    } as never);
  const layer = (price: number, listPrice: number) => ({
    unit: "u-case",
    price,
    listPrice,
    source: "customer-shape" as const,
    aboveList: price > listPrice,
  });

  it("flag off: the ladder price (identical to master)", () => {
    expect(build("Case")).toMatchObject({ unitPrice: 480, priceType: PriceType.STANDARD });
    expect(build("Case", { customerLayer: null })).toEqual(build("Case"));
  });
  it("R1a: a Case in the customer's shape bills $377.14 SPECIAL against the $480 list", () => {
    expect(build("Case", { customerLayer: layer(377.14, 480) })).toMatchObject({
      unitPrice: 377.14,
      originalPrice: 480,
      priceType: PriceType.SPECIAL,
    });
  });
  it("nit 6: the original/list is the LAYER row's list when one exists (here $500, the ladder says $480), so type and original agree", () => {
    expect(build("Case", { customerLayer: layer(377.14, 500) })).toMatchObject({
      unitPrice: 377.14,
      originalPrice: 500,
      priceType: PriceType.SPECIAL,
    });
  });
  it("R2: above the unit's list the line is MANUAL with original = list and NO staff attribution", () => {
    const line = build("Case", { customerLayer: layer(500, 480) });
    expect(line).toMatchObject({ unitPrice: 500, originalPrice: 480, priceType: PriceType.MANUAL });
    expect(line.overriddenBy).toBeUndefined();
  });
});

describe("R3 / R3a: the pre-fill is the resolver's price, never last-given", () => {
  const history = {
    p1: { lastPrice: 36, listPriceAtTime: 42 },
    p2: { lastPrice: 9, listPriceAtTime: 10 },
  };
  const run = async (rows: Rows, flag = true) => {
    const h = deps({ rows, flag });
    const svc = {
      prisma: {
        forTenant: () => ({
          ...h.db,
          customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: 1 }) },
          customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
          product: { findMany: jest.fn().mockResolvedValue([product, { ...product, id: "p2" }]) },
        }),
        getTenantId: () => "t1",
      },
      entitlements: { hasFlag: h.hasFlag },
    } as never;
    return omitCustomerLayerHistory(svc, "c1", history);
  };

  it("R3a: typed pack $33 with last-given $36: the last-given entry is dropped (pre-fill = the resolver's $33)", async () => {
    expect(await run([["pack", 33]])).toEqual({ p2: history.p2 });
  });
  it("S19-b: a typed Case price only leaves the pack's last-given in place", async () => {
    expect(await run([["u-case", 450]])).toEqual(history);
  });
  it("nit 1: omitCustomerLayerHistory's own reads carry the tenantId", async () => {
    const seen: any[] = [];
    const h = deps({ rows: [["pack", 33]] });
    const svc = {
      prisma: {
        forTenant: () => ({
          ...h.db,
          customer: {
            findFirst: jest.fn(async (a: any) => (seen.push(a.where), { pricingTier: 1 })),
          },
          customerPrice: { findMany: jest.fn(async (a: any) => (seen.push(a.where), [])) },
          product: { findMany: jest.fn(async (a: any) => (seen.push(a.where), [product])) },
        }),
        getTenantId: () => "t1",
      },
      entitlements: { hasFlag: h.hasFlag },
    } as never;
    await omitCustomerLayerHistory(svc, "c1", { p1: { lastPrice: 36, listPriceAtTime: 42 } });
    expect(seen).toHaveLength(3);
    for (const w of seen) expect(w.tenantId).toBe("t1");
  });
  it("flag off, or no typed price: the history as it is", async () => {
    expect(await run([["pack", 33]], false)).toEqual(history);
    expect(await run([])).toEqual(history);
  });
});
