import { MrrService } from "./mrr.service";

function make() {
  const prisma = {
    tenantSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { tenantId: "t-starter", planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
        { tenantId: "t-business", planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
      ]),
    },
    tenantAddon: {
      // Keyed to t-starter only — proves add-ons are grouped per tenant (T5), not summed
      // once and applied to every subscription. Filters by `where.tenantId` when present
      // (priceTenant()'s own scoped query) so it behaves like a real Prisma call, not a
      // static fixture that would leak t-starter's addon into every other tenant's total.
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const all = [{ tenantId: "t-starter", priceSnapshot: 12, quantity: 2 }];
        return Promise.resolve(
          where?.tenantId ? all.filter((a) => a.tenantId === where.tenantId) : all,
        );
      }),
    },
    tenant: {
      count: jest
        .fn()
        .mockImplementation(({ where }: any) => Promise.resolve(where.status === "TRIAL" ? 3 : 1)),
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        const byId: Record<string, any> = {
          "t-starter": {
            status: "ACTIVE",
            class: "PRODUCTION",
            subscription: { planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
          },
          "t-business": {
            status: "ACTIVE",
            class: "PRODUCTION",
            subscription: { planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
          },
        };
        return Promise.resolve(byId[where.id] ?? null);
      }),
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

  // REG-743-N5/F2 (review finding F6): unpricedActiveTenants/zeroPricedActiveTenants are
  // derived from the SAME per-row priceSubscription() result as payingTenants (never a
  // separate raw-column tenant.count(), which review finding F4 showed can disagree with the
  // real price) — and activeWithoutSubscription still comes from its own dedicated
  // tenant.count() query. Distinct fixture counts per bucket (1 unpriced, 2 zero-priced, a
  // DIFFERENT activeWithoutSubscription value) so swapping any two of these fields would fail
  // this test, not just prove "some number came back".
  it("splits unpriced (F2) vs zero-priced (full-discount) rows, and wires activeWithoutSubscription to its own query", async () => {
    const prisma = {
      tenantSubscription: {
        findMany: jest.fn().mockResolvedValue([
          { tenantId: "t-paying", planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
          // Missing a snapshot, no add-ons to rescue it — genuinely unpriced (F2's shape).
          { tenantId: "t-unpriced", planKey: "TEAM", basePriceSnapshot: null, discount: 0 },
          // Has a snapshot, fully discounted — zero-priced, not "missing data".
          { tenantId: "t-zero-a", planKey: "GROWTH", basePriceSnapshot: 100, discount: 100 },
          { tenantId: "t-zero-b", planKey: "GROWTH", basePriceSnapshot: 50, discount: 50 },
        ]),
      },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: {
        // REG-743-F3: activeWithoutSubscription's query is widened to an OR (no subscription
        // row, OR a subscription row with no planKey) — discriminate on that shape, not a
        // stale `where.subscription === null` check that the widening made unreachable.
        count: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.OR ? 7 : 0)),
      },
      billingEvent: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: 0 } }) },
    } as any;

    const o = await new MrrService(prisma).computeOverview();

    expect(o.payingTenants).toBe(1);
    expect(o.unpricedActiveTenants).toBe(1);
    expect(o.zeroPricedActiveTenants).toBe(2);
    expect(o.activeWithoutSubscription).toBe(7);

    expect(prisma.tenant.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE",
          class: "PRODUCTION",
          OR: [{ subscription: null }, { subscription: { planKey: null } }],
        }),
      }),
    );
  });

  // REG-743-F4 (review finding): a null basePriceSnapshot must NOT be flagged "unpriced" when
  // add-on revenue still prices the row above $0 — the raw-column check the fix-round review
  // caught would otherwise show the same tenant as both "paying" and "priced $0" at once.
  it("REG-743-F4 a null-snapshot row rescued by add-ons counts as paying, never as unpriced", async () => {
    const prisma = {
      tenantSubscription: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { tenantId: "t-addon-only", planKey: "TEAM", basePriceSnapshot: null, discount: 0 },
          ]),
      },
      tenantAddon: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ tenantId: "t-addon-only", priceSnapshot: 25, quantity: 1 }]),
      },
      tenant: { count: jest.fn().mockResolvedValue(0) },
      billingEvent: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: 0 } }) },
    } as any;

    const o = await new MrrService(prisma).computeOverview();

    expect(o.mrr).toBe(25);
    expect(o.payingTenants).toBe(1);
    expect(o.unpricedActiveTenants).toBe(0);
    expect(o.zeroPricedActiveTenants).toBe(0);
  });

  // REG-743-N5: a subscription row matching payingWhere (it has a planKey) is not the same
  // claim as "this tenant pays" — a full discount (or a null snapshot) prices the row $0.
  // payingTenants and byPlan[].tenants must count ONLY rows that actually contribute money,
  // so the dashboard never says "N paying tenants" and "$0 from them" for the same row.
  it("REG-743-N5 excludes a $0 row (full discount) from payingTenants and byPlan tenant counts", async () => {
    const prisma = {
      tenantSubscription: {
        findMany: jest.fn().mockResolvedValue([
          { tenantId: "t-starter", planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
          // A real Stripe subscription (has a planKey) fully discounted to $0 — still a
          // payingWhere match, never a "paying tenant".
          { tenantId: "t-freebie", planKey: "GROWTH", basePriceSnapshot: 100, discount: 100 },
        ]),
      },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: { count: jest.fn().mockResolvedValue(0) },
      billingEvent: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: 0 } }) },
    } as any;

    const o = await new MrrService(prisma).computeOverview();

    expect(o.mrr).toBe(59);
    expect(o.payingTenants).toBe(1);
    expect(o.byPlan).toEqual([
      { planKey: "STARTER", tenants: 1, baseMrr: 59 },
      { planKey: "GROWTH", tenants: 0, baseMrr: 0 },
    ]);
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

  // REG-743-N1 (L-119): priceTenant() must equal that SAME tenant's own contribution to
  // computeOverview()'s total — the card and the platform-wide rollup are proven to be the
  // same function here, not just asserted to be by their shared source code.
  it("REG-743-N1 priceTenant equals the tenant's own share of computeOverview for the same fixture", async () => {
    const { svc, prisma } = make();
    const overview = await svc.computeOverview();

    const starterPrice = await svc.priceTenant("t-starter");
    const businessPrice = await svc.priceTenant("t-business");

    expect(starterPrice).toBe(59 + 24); // base 59, no discount, + its own addon (12 × 2)
    expect(businessPrice).toBe(349 - 10); // base 349 − discount 10, no addons of its own
    expect(starterPrice + businessPrice).toBe(overview.mrr);

    // priceTenant() gates the SAME way computeOverview() does — non-PRODUCTION or
    // non-ACTIVE tenants never reach the pricing math at all.
    prisma.tenant.findUnique.mockResolvedValueOnce({
      status: "ACTIVE",
      class: "DEMO",
      subscription: { planKey: "GROWTH", basePriceSnapshot: 249, discount: 0 },
    });
    expect(await svc.priceTenant("t-demo")).toBe(0);

    prisma.tenant.findUnique.mockResolvedValueOnce(null);
    expect(await svc.priceTenant("t-missing")).toBe(0);

    // Review finding: the gate must also match payingWhere's deletedAt: null — a
    // soft-deleted tenant a webhook later flips back to status ACTIVE (deletedAt
    // untouched by that write) must still price $0, never a stale snapshot.
    prisma.tenant.findUnique.mockResolvedValueOnce({
      status: "ACTIVE",
      class: "PRODUCTION",
      deletedAt: new Date("2026-01-01"),
      subscription: { planKey: "GROWTH", basePriceSnapshot: 249, discount: 0 },
    });
    expect(await svc.priceTenant("t-deleted")).toBe(0);
  });
});
