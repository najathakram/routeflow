import { resolveTierPrices } from "./counter-sale-tier-price";

/**
 * S19b A-4 (SA-811a): the counter-sale price-edit audit's baseline is the price create() judges and bills: the customer
 * layer's $33 flag-on (the pack typed), master's tier-3 $39 flag-off or with no svc. It still never throws.
 */
const V2 = "flag.units_prices_v2";
const PRODUCT = {
  id: "p1",
  unit: "Box",
  unitsPerBox: 24,
  orderUnitRef: "pack",
  packAuto: 0,
  pricePerUnit: 42,
  priceTier2: 40,
  priceTier3: 39,
  priceTier4: null,
  priceTier5: null,
};

function harness(opts: { typed?: boolean; flag?: boolean }) {
  const hasFlag = jest.fn(async (_t: string, k: string) => k === V2 && (opts.flag ?? true));
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: 3 }) },
    customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    customerUnitPrice: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.typed ? [{ productId: "p1", unitRef: "pack", price: "33.00" }] : [],
        ),
    },
    productUnit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = { prisma: { getTenantId: () => "t1" }, entitlements: { hasFlag } };
  return { db: db as never, svc, hasFlag };
}

describe("resolveTierPrices: the audit baseline reads the customer layer (S19b A-4)", () => {
  it("flag on: $33 (the typed pack price)", async () => {
    const h = harness({ typed: true });
    expect((await resolveTierPrices(h.db, "c1", ["p1"], h.svc)).get("p1")).toBe(33);
  });
  it("flag OFF with a typed row: master's tier-3 $39, the flag was asked", async () => {
    const h = harness({ typed: true, flag: false });
    expect((await resolveTierPrices(h.db, "c1", ["p1"], h.svc)).get("p1")).toBe(39);
    expect(h.hasFlag).toHaveBeenCalledWith("t1", V2);
  });
  it("no svc (an existing caller): master's $39, the flag never asked", async () => {
    const h = harness({ typed: true });
    expect((await resolveTierPrices(h.db, "c1", ["p1"])).get("p1")).toBe(39);
    expect(h.hasFlag).not.toHaveBeenCalled();
  });
  it("no typed row: master's $39 and the flag is never asked", async () => {
    const h = harness({});
    expect((await resolveTierPrices(h.db, "c1", ["p1"], h.svc)).get("p1")).toBe(39);
    expect(h.hasFlag).not.toHaveBeenCalled();
  });
  it("still never throws: a failing read gives an empty map", async () => {
    const h = harness({ typed: true });
    (h.db as any).customer.findFirst.mockRejectedValue(new Error("db down"));
    expect((await resolveTierPrices(h.db, "c1", ["p1"], h.svc)).size).toBe(0);
  });
});
