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
  describe("MUST-2: the period window drives the month multiplier", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const START = new Date("2026-10-12T00:00:00.000Z");
    const win = (days: number) => ({
      periodStart: START,
      periodEnd: new Date(START.getTime() + days * DAY),
    });
    const run = async (days: number, cycle: "MONTHLY" | "ANNUAL" = "MONTHLY") => {
      const { builder } = make({ addons: [addon({ priceSnapshot: 19.99, quantity: 2 })] });
      const r = await builder.build("tenant-acme", cycle, win(days));
      if (!r.ok) throw new Error("expected a draft");
      return r;
    };

    it("a 30-day window is 1x", async () => {
      const r = await run(30);
      expect(r.lines.map((l) => l.amount)).toEqual([149, 39.98]);
      expect(r.total).toBe(188.98);
      expect(r.needsReview).toBe(false);
      expect(r.irregularPeriod).toBe(false);
    });

    it("pin: BLD-1's exact fixture (19.995 x 2) through a 30-day window equals its no-window result", async () => {
      const { builder } = make({ addons: [addon({ priceSnapshot: 19.995, quantity: 2 })] });
      const plain = await builder.build("tenant-acme", "MONTHLY");
      const windowed = await builder.build("tenant-acme", "MONTHLY", win(30));
      if (!plain.ok || !windowed.ok) throw new Error("expected drafts");
      // cyclePrice rounds the unit (19.995 -> 20.00) BEFORE x qty x months on both paths.
      expect(windowed.lines.map((l) => l.amount)).toEqual([149, 40]);
      expect(windowed.total).toBe(189);
      expect(windowed.lines).toEqual(plain.lines);
      expect(windowed.total).toBe(plain.total);
    });

    it("a 90-day (quarterly) window is 3x, rounded per line", async () => {
      const r = await run(90);
      expect(r.lines.map((l) => l.amount)).toEqual([447, 119.94]);
      expect(r.lines[0]).toMatchObject({ quantity: 3, unitAmount: 149 });
      expect(r.lines[1]).toMatchObject({ quantity: 6, unitAmount: 19.99 });
      expect(r.total).toBe(566.94);
      expect(r.needsReview).toBe(false);
    });

    it("a 180-day window is 6x", async () => {
      const r = await run(180);
      expect(r.lines.map((l) => l.amount)).toEqual([894, 239.88]);
      expect(r.total).toBe(1133.88);
      expect(r.needsReview).toBe(false);
    });

    it("a 45-day window is not a whole number of months: still issued, needsReview + irregular", async () => {
      const r = await run(45);
      expect(r.needsReview).toBe(true);
      expect(r.irregularPeriod).toBe(true);
      expect(r.lines[0].amount).toBe(149); // periodMonths rounds 1.48 to 1; never guessed higher
    });

    it("an ANNUAL window is not multiplied; 365 and 366 days are regular, 400 days needsReview", async () => {
      for (const d of [365, 366]) {
        const r = await run(d, "ANNUAL");
        expect(r.lines[0].amount).toBe(1490);
        expect(r.needsReview).toBe(false);
        expect(r.irregularPeriod).toBe(false);
      }
      const odd = await run(400, "ANNUAL");
      expect(odd.lines[0].amount).toBe(1490);
      expect(odd.needsReview).toBe(true);
      expect(odd.irregularPeriod).toBe(true);
    });

    it("no window (legacy callers) is 1x and regular", async () => {
      const { builder } = make();
      const r = await builder.build("tenant-acme", "MONTHLY");
      if (!r.ok) throw new Error("expected a draft");
      expect(r.irregularPeriod).toBe(false);
    });
  });
});
