/**
 * Units S19 (flag.units_prices_v2): a manual invoice line is judged against the customer's TYPED unit price, not the
 * tier price. Flag off, or no typed row: master's baseline, no entitlement lookup for the new flag.
 */
import { loadOverride, priceInvoiceLine } from "./invoice-line-override";

const product = {
  id: "p1",
  name: "Widget",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: 42,
  priceTier2: 40,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const caseRow = {
  id: "u-case",
  productId: "p1",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};

function harness(opts: { flag: boolean; typed: Array<[string, number]>; tier?: number }) {
  const hasFlag = jest.fn().mockResolvedValue(opts.flag);
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: opts.tier ?? 1 }) },
    customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
    customerUnitPrice: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.typed.map(([unitRef, price]) => ({ productId: "p1", unitRef, price })),
        ),
    },
  };
  const prisma = { forTenant: () => db, getTenantId: () => "t1" };
  const ladders = new Map([["p1", [caseRow]]]);
  const load = () =>
    loadOverride(
      prisma,
      { customerId: "c1", items: [{ productId: "p1" }] },
      ladders as never,
      "actor",
      {
        hasFlag,
      },
    );
  return { hasFlag, load };
}

describe("loadOverride + priceInvoiceLine: the typed price is the baseline", () => {
  it("flag on, typed PACK 33: typing 33 is no override (STANDARD-or-SPECIAL, no reason); 30 needs a reason", async () => {
    const ctx = (await harness({ flag: true, typed: [["pack", 33]] }).load())!;
    const at33 = priceInvoiceLine({ ctx, item: { unitPrice: 33 }, product, unitLabel: null });
    expect(at33.unitPrice).toBe(33);
    expect(at33.stamp).toMatchObject({
      priceType: "SPECIAL",
      originalPrice: 42,
      overriddenBy: null,
    });
    expect(() =>
      priceInvoiceLine({ ctx, item: { unitPrice: 30 }, product, unitLabel: null }),
    ).toThrow(/reason is required/);
    expect(
      priceInvoiceLine({
        ctx,
        item: { unitPrice: 30, overrideReason: "volume" },
        product,
        unitLabel: null,
      }).stamp,
    ).toMatchObject({ priceType: "DISCOUNTED", overriddenBy: "actor" });
  });

  it("flag on, typed Case (ProductUnit id) 450: a Case line typed at 450 is no override", async () => {
    const ctx = (await harness({ flag: true, typed: [["u-case", 450]] }).load())!;
    const r = priceInvoiceLine({ ctx, item: { unitPrice: 450 }, product, unitLabel: "Case" });
    expect(r.unitPrice).toBe(450);
    expect(r.stamp).toMatchObject({ priceType: "SPECIAL", overriddenBy: null });
  });

  it("flag OFF with typed rows (revoked): master's baseline - 33 on a tier-1 customer is a DISCOUNTED override", async () => {
    const ctx = (await harness({ flag: false, typed: [["pack", 33]] }).load())!;
    expect(() =>
      priceInvoiceLine({ ctx, item: { unitPrice: 33 }, product, unitLabel: null }),
    ).not.toThrow();
    expect(
      priceInvoiceLine({ ctx, item: { unitPrice: 33 }, product, unitLabel: null }).stamp.priceType,
    ).toBe("DISCOUNTED");
  });

  it("no typed rows: the flag is never asked", async () => {
    const h = harness({ flag: true, typed: [] });
    const ctx = (await h.load())!;
    expect(h.hasFlag).not.toHaveBeenCalled();
    expect(
      priceInvoiceLine({ ctx, item: { unitPrice: 42 }, product, unitLabel: null }).stamp,
    ).toMatchObject({
      priceType: "STANDARD",
    });
  });

  it("the tier still resolves through customerTierFor flag-on (tier 2 => $40 baseline)", async () => {
    const ctx = (await harness({ flag: true, typed: [["u-other", 5]], tier: 2 }).load())!;
    expect(ctx.tierOf("p1")).toBe(2);
    expect(
      priceInvoiceLine({ ctx, item: { unitPrice: 40 }, product, unitLabel: null }).unitPrice,
    ).toBe(40);
  });
});
