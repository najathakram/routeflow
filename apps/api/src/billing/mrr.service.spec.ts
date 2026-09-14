import { MrrService } from "./mrr.service";

function make() {
  const prisma = {
    tenantSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
        { planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
      ]),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue([{ priceSnapshot: 12, quantity: 2 }]),
    },
    tenant: {
      count: jest
        .fn()
        .mockImplementation(({ where }: any) => Promise.resolve(where.status === "TRIAL" ? 3 : 1)),
    },
    billingEvent: {
      // ledger (no createdAt filter) vs 30-day window (has createdAt) — both now also carry
      // a tenant.class filter (Phase 0 T9), so distinguish on createdAt, not on `where` alone.
      aggregate: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve({ _sum: { amountDelta: where?.createdAt ? 50 : 422 } }),
        ),
    },
  } as any;
  return { svc: new MrrService(prisma), prisma };
}

describe("MrrService.computeOverview", () => {
  it("computes MRR = Σ(base + add-ons − discounts) from snapshots", async () => {
    const o = await make().svc.computeOverview();
    expect(o.baseMrr).toBe(408); // 59 + 349
    expect(o.addonMrr).toBe(24); // 12 × 2
    expect(o.discountTotal).toBe(10);
    expect(o.mrr).toBe(422); // 408 + 24 − 10
    expect(o.payingTenants).toBe(2);
    expect(o.trialTenants).toBe(3);
    expect(o.readOnlyTenants).toBe(1);
  });

  it("reconciles against the BillingEvent ledger + reports MoM delta", async () => {
    const o = await make().svc.computeOverview();
    expect(o.ledgerMrr).toBe(422); // Σ amountDelta ≈ mrr
    expect(o.momDelta).toBe(50); // last 30 days
  });

  it("breaks MRR down by plan, highest first, net of discounts", async () => {
    const o = await make().svc.computeOverview();
    expect(o.byPlan).toEqual([
      { planKey: "BUSINESS", tenants: 1, baseMrr: 339 }, // 349 − 10 discount
      { planKey: "STARTER", tenants: 1, baseMrr: 59 },
    ]);
  });

  it("only counts add-ons for tenants with a PAYING base plan (planKey != null)", async () => {
    const { svc, prisma } = make();
    await svc.computeOverview();
    // Mirror payingWhere: an add-on on a plan-less ACTIVE tenant must NOT book MRR.
    const where = prisma.tenantAddon.findMany.mock.calls[0][0].where;
    expect(where.active).toBe(true);
    expect(where.tenant.status).toBe("ACTIVE");
    expect(where.tenant.subscription).toEqual({ planKey: { not: null } });
  });

  it("uses a fixed trailing 30-day window for momDelta (no month-overflow)", async () => {
    const { svc, prisma } = make();
    await svc.computeOverview();
    // The windowed aggregate (the call WITH a createdAt filter) must start ~30 days before now.
    const windowed = prisma.billingEvent.aggregate.mock.calls.find(
      (c: any[]) => c[0]?.where?.createdAt,
    );
    const gte = windowed[0].where.createdAt.gte as Date;
    const days = (Date.now() - gte.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  // Phase 0 T9: the first five customers are FREE PILOTS and every TEST/DEMO/INTERNAL
  // tenant must be invisible to revenue — every query MrrService issues has to carry
  // tenant: { class: "PRODUCTION" } so a QA or demo tenant's subscription/addon/ledger
  // rows can never inflate the number the platform admin reads as real revenue.
  it("excludes non-PRODUCTION tenants from mrr and ledgerMrr", async () => {
    const { svc, prisma } = make();
    await svc.computeOverview();

    expect(prisma.tenantSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenant: expect.objectContaining({ class: "PRODUCTION" }),
        }),
      }),
    );
    expect(prisma.tenantAddon.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenant: expect.objectContaining({ class: "PRODUCTION" }),
        }),
      }),
    );
    for (const call of prisma.tenant.count.mock.calls) {
      expect(call[0].where.class).toBe("PRODUCTION");
    }
    for (const call of prisma.billingEvent.aggregate.mock.calls) {
      expect(call[0].where.tenant).toEqual({ class: "PRODUCTION" });
    }
  });

  // F6 (owner ruling): the five pilots are FREE and never paying MRR; revenue excludes
  // Tenant.class TEST/DEMO/INTERNAL. Fixture proves the engine's total is exactly the
  // paying tenant's price — a DEMO tenant's paid plan and a subscription-less PRODUCTION
  // pilot both contribute $0, mirroring the real `payingWhere` filter (tenant.status ===
  // ACTIVE && tenant.class === PRODUCTION && planKey != null) against a raw fixture.
  it("prices only the paying PRODUCTION tenant — DEMO and a no-subscription pilot contribute $0", async () => {
    const fixtureSubs = [
      {
        planKey: "GROWTH",
        basePriceSnapshot: 249,
        discount: 0,
        tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
      },
      // DEMO tenant on a paid plan — excluded by the class filter, never revenue.
      {
        planKey: "GROWTH",
        basePriceSnapshot: 249,
        discount: 0,
        tenant: { status: "ACTIVE", deletedAt: null, class: "DEMO" },
      },
      // t-pilot: PRODUCTION + ACTIVE but has no subscription row at all — a free pilot
      // never appears in tenantSubscription, so it never reaches this query either.
    ];
    const prisma = {
      tenantSubscription: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(
              fixtureSubs
                .filter(
                  (s) =>
                    s.tenant.status === where.tenant.status &&
                    s.tenant.class === where.tenant.class,
                )
                .map(({ tenant, ...rest }) => rest),
            ),
          ),
      },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: { count: jest.fn().mockResolvedValue(0) },
      billingEvent: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: 0 } }) },
    } as any;

    const o = await new MrrService(prisma).computeOverview();

    expect(o.mrr).toBe(249);
    expect(o.payingTenants).toBe(1);
  });
});
