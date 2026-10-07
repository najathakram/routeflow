// PR1 (manual invoices due) BLD-1..5: the pure draft the issuer persists. Money goes through
// roundMoney / cyclePrice only; the fixtures use acme-style placeholders.
import { BadRequestException } from "@nestjs/common";
import { RfInvoiceBuilder } from "./rf-invoice-builder";

const PRICING = {
  planKey: "STARTER",
  planName: "Starter",
  monthly: 149,
  annual: 1490,
  source: "catalog",
  currency: "usd",
};

function make(opts: { pricing?: any; pricingError?: Error; addons?: any[] } = {}) {
  const pricing = {
    resolveTenantPricing: jest.fn(async () => {
      if (opts.pricingError) throw opts.pricingError;
      return opts.pricing ?? PRICING;
    }),
  };
  const prisma = {
    tenantAddon: { findMany: jest.fn(async () => opts.addons ?? []) },
  };
  const builder = new RfInvoiceBuilder(prisma as any, pricing as any);
  return { builder, prisma, pricing };
}

const addon = (over: Record<string, unknown> = {}) => ({
  addonKey: "advanced_routes",
  sku: "ADVANCED_ROUTES",
  quantity: 1,
  priceSnapshot: 19.99,
  isComp: false,
  active: true,
  ...over,
});

describe("RfInvoiceBuilder", () => {
  it("BLD-1: monthly plan line + add-on 19.995 x 2 -> [149.00, 40.00], total 189.00", async () => {
    const { builder } = make({ addons: [addon({ priceSnapshot: 19.995, quantity: 2 })] });
    const r = await builder.build("tenant-acme", "MONTHLY");
    if (!r.ok) throw new Error("expected a draft");
    // One formula for both cycles, matching manual-activation-addons.ts (cycleAmount =
    // roundMoney(cyclePrice(price, cycle) * qty)): cyclePrice rounds 19.995 to 20.00 first, so the
    // line is 40.00 - the invoice must equal what the other billing paths charge.
    expect(r.lines.map((l) => l.amount)).toEqual([149, 40]);
    expect(r.lines.map((l) => l.kind)).toEqual(["PLAN", "ADDON"]);
    expect(r.total).toBe(189);
    expect(r.needsReview).toBe(false);
    expect(r.currency).toBe("USD");
  });

  it("BLD-2: a comp add-on is never a line (predicate is billableAddonWhere, and a stray comp row is dropped)", async () => {
    const { builder, prisma } = make({
      addons: [addon({ sku: "COMPED", isComp: true, priceSnapshot: 50 }), addon()],
    });
    const r = await builder.build("tenant-acme", "MONTHLY");
    if (!r.ok) throw new Error("expected a draft");
    expect(prisma.tenantAddon.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-acme", active: true, isComp: false } }),
    );
    expect(r.lines.map((l) => l.code)).toEqual(["STARTER", "ADVANCED_ROUTES"]);
    expect(r.total).toBe(168.99);
  });

  it("BLD-3: annual uses the annual plan price and the 10-month add-on price", async () => {
    const { builder } = make({ addons: [addon({ priceSnapshot: 19.99, quantity: 2 })] });
    const r = await builder.build("tenant-acme", "ANNUAL");
    if (!r.ok) throw new Error("expected a draft");
    expect(r.lines[0]).toMatchObject({ kind: "PLAN", unitAmount: 1490, amount: 1490 });
    expect(r.lines[1]).toMatchObject({
      kind: "ADDON",
      unitAmount: 199.9,
      quantity: 2,
      amount: 399.8,
    });
    expect(r.total).toBe(1889.8);
  });

  it("BLD-4 (builder half): no resolvable price -> no draft, reason NO_PRICE; other errors propagate", async () => {
    const noPrice = make({ pricingError: new BadRequestException("No price is resolvable") });
    const r = await noPrice.builder.build("tenant-acme", "MONTHLY");
    expect(r).toMatchObject({ ok: false, reason: "NO_PRICE" });
    expect(noPrice.prisma.tenantAddon.findMany).not.toHaveBeenCalled();

    const boom = make({ pricingError: new Error("connection reset") });
    await expect(boom.builder.build("tenant-acme", "MONTHLY")).rejects.toThrow("connection reset");
  });

  it("BLD-5: a null price snapshot is an amount-0 line and needsReview, with no priceUnknown field anywhere", async () => {
    const { builder } = make({ addons: [addon({ priceSnapshot: null })] });
    const r = await builder.build("tenant-acme", "MONTHLY");
    if (!r.ok) throw new Error("expected a draft");
    expect(r.lines[1]).toMatchObject({ kind: "ADDON", unitAmount: 0, amount: 0 });
    expect(r.needsReview).toBe(true);
    expect(r.total).toBe(149);
    expect(JSON.stringify(r)).not.toMatch(/priceUnknown/i);
    expect(Object.keys(r.lines[1]).sort()).toEqual(
      ["amount", "code", "kind", "label", "quantity", "unitAmount"].sort(),
    );
  });

  it("feature overrides are never lines (the builder reads add-ons only)", async () => {
    const { builder, prisma } = make();
    await builder.build("tenant-acme", "MONTHLY");
    expect(Object.keys(prisma)).toEqual(["tenantAddon"]);
  });
});
