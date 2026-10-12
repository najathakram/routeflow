import { MrrService } from "./mrr.service";
import { FeatureOverrideService } from "./feature-override.service";
import { roundMoney } from "@routeflow/pricing";

function make() {
  const prisma = {
    tenantSubscription: {
      // SA-736r: the unbilled-coupon cohort count (the real rows are proven in mrr-coupon.db.spec.ts).
      count: jest.fn().mockResolvedValue(0),
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

  it("T15 REG-B866-BYPLAN byPlan baseMrr is gross, highest first (flips :78 'net of discounts', SA-277)", async () => {
    const o = await make().svc.computeOverview();
    expect(o.byPlan).toEqual([
      { planKey: "BUSINESS", tenants: 1, baseMrr: 349 }, // gross — same formula as the top-level baseMrr accumulator
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
    // SA-736r M2: the add-on query mirrors payingWhere's couponFull gate, so a coupon tenant's add-ons leave
    // `mrr` exactly as they leave `ledgerMrr`.
    expect(where.tenant.subscription).toEqual({ planKey: { not: null }, couponFull: false });
  });

  it("SA-736r M2: payingWhere itself carries couponFull:false (the subscription read AND the add-on read)", async () => {
    const { svc, prisma } = make();
    await svc.computeOverview();
    expect(prisma.tenantSubscription.findMany.mock.calls[0][0].where).toMatchObject({
      planKey: { not: null },
      couponFull: false,
    });
  });

  it("SA-736r: the unbilled cohort is counted from its own query, never from payingWhere", async () => {
    const { svc, prisma } = make();
    prisma.tenantSubscription.count.mockResolvedValue(2);
    const o = await svc.computeOverview();
    expect(o.couponUnbilledTenants).toBe(2);
    expect(prisma.tenantSubscription.count.mock.calls[0][0].where).toMatchObject({
      couponFull: true,
    });
  });

  // SA-693: a comp books 0 by construction (priceSnapshot 0), and both MRR reads also filter it out
  // through the shared billableAddonWhere, so a comp row that ever carried a stale price still adds 0.
  it("SA-693: neither MRR read counts a comp add-on (isComp: false in both where clauses)", async () => {
    const { svc, prisma } = make();
    await svc.computeOverview();
    expect(prisma.tenantAddon.findMany.mock.calls[0][0].where.isComp).toBe(false);

    prisma.tenantAddon.findMany.mockClear();
    await svc.priceTenant("t-starter");
    expect(prisma.tenantAddon.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "t-starter",
      active: true,
      isComp: false,
    });
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
        count: jest.fn().mockResolvedValue(0), // SA-736r: the unbilled-coupon cohort count
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
        count: jest.fn().mockResolvedValue(0), // SA-736r: the unbilled-coupon cohort count
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
        count: jest.fn().mockResolvedValue(0), // SA-736r: the unbilled-coupon cohort count
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
    // B866/SA-277: byPlan.baseMrr is gross (matches the top-level baseMrr accumulator), so
    // GROWTH's fully-discounted row still contributes its $100 base and sorts ahead of STARTER.
    expect(o.byPlan).toEqual([
      { planKey: "GROWTH", tenants: 0, baseMrr: 100 },
      { planKey: "STARTER", tenants: 1, baseMrr: 59 },
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
        count: jest.fn().mockResolvedValue(0), // SA-736r: the unbilled-coupon cohort count
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

// Feature grants v2 (brief B) — MRR-truth oracle: an override GRANT of any `kind` is a comp,
// never a Stripe item, never counted in MRR (see mrr.service.ts's exclusion-invariant comment).
// This wires MrrService and FeatureOverrideService against ONE shared mock prisma so the same
// tenant's state is genuinely shared across both collaborators, not two independently-stubbed
// fixtures that could drift apart.
describe("MrrService — feature-override MRR exclusion oracle (brief B)", () => {
  function makeShared() {
    let addonRows: { tenantId: string; priceSnapshot: number; quantity: number }[] = [];
    const overrideRows: any[] = [];
    const prisma = {
      tenantSubscription: {
        count: jest.fn().mockResolvedValue(0), // SA-736r: the unbilled-coupon cohort count
        findMany: jest
          .fn()
          .mockResolvedValue([
            { tenantId: "t-starter", planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
          ]),
      },
      tenantAddon: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(
              where?.tenantId ? addonRows.filter((a) => a.tenantId === where.tenantId) : addonRows,
            ),
          ),
      },
      tenant: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.id === "t-starter"
              ? {
                  status: "ACTIVE",
                  class: "PRODUCTION",
                  deletedAt: null,
                  subscription: { planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
                }
              : null,
          ),
        ),
      },
      billingEvent: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: 0 } }) },
      tenantFeatureOverride: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(overrideRows.filter((r) => r.tenantId === where.tenantId)),
          ),
        create: jest.fn().mockImplementation(({ data }: any) => {
          const created = { id: `ov-${overrideRows.length + 1}`, revokedAt: null, ...data };
          overrideRows.push(created);
          return Promise.resolve(created);
        }),
        update: jest.fn().mockImplementation(({ where, data }: any) => {
          const target = overrideRows.find(
            (r) => r.id === where.id && r.tenantId === where.tenantId,
          );
          Object.assign(target, data);
          return Promise.resolve(target);
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;
    return {
      mrr: new MrrService(prisma),
      overrides: new FeatureOverrideService(prisma),
      prisma,
      purchaseAddon: (row: { tenantId: string; priceSnapshot: number; quantity: number }) =>
        addonRows.push(row),
    };
  }

  it("STARTER tenant at $S: a PILOT GRANT override never moves MRR; purchasing the real AddonSku does; revoking the override leaves the purchase untouched", async () => {
    const { mrr, overrides, prisma, purchaseAddon } = makeShared();

    await expect(mrr.priceTenant("t-starter")).resolves.toBe(59); // $S baseline

    const grant = await overrides.create({
      tenantId: "t-starter",
      featureKey: "tobacco_dealer",
      effect: "GRANT",
      kind: "PILOT",
      reason: "pilot: waive addon gate while evaluating",
      expiresAt: null,
      createdById: "admin1",
    });
    await expect(mrr.priceTenant("t-starter")).resolves.toBe(59); // unchanged — no TenantAddon row

    purchaseAddon({ tenantId: "t-starter", priceSnapshot: 12, quantity: 2 }); // $A = 24
    await expect(mrr.priceTenant("t-starter")).resolves.toBe(83); // $S + $A

    await overrides.revoke("t-starter", grant.id);
    await expect(mrr.priceTenant("t-starter")).resolves.toBe(83); // unchanged — purchase stands

    // Not just "the number came out right" -- MrrService itself never once touched the
    // overrides table across any of the four priceTenant() calls above. Only overrides.create()/
    // revoke() did (and neither of those is findMany).
    expect(prisma.tenantFeatureOverride.findMany).not.toHaveBeenCalled();
  });

  it("same invariant for a GRANDFATHER-kind override", async () => {
    const { mrr, overrides } = makeShared();
    await overrides.create({
      tenantId: "t-starter",
      featureKey: "recurring_routes",
      effect: "GRANT",
      kind: "GRANDFATHER",
      reason: "grandfathered under the old pricing",
      expiresAt: null,
      createdById: null,
    });
    await expect(mrr.priceTenant("t-starter")).resolves.toBe(59);
  });

  it("computeOverview() never queries tenantFeatureOverride at all", async () => {
    const { mrr, overrides, prisma } = makeShared();
    await overrides.create({
      tenantId: "t-starter",
      featureKey: "tobacco_dealer",
      effect: "GRANT",
      kind: "COMP",
      reason: "comp",
      expiresAt: null,
      createdById: null,
    });
    const o = await mrr.computeOverview();
    expect(o.mrr).toBe(59); // unaffected by the override created above
    expect(prisma.tenantFeatureOverride.findMany).not.toHaveBeenCalled();
  });
});

// Billing QA 2026-09-25 (local-assets/proofs/2026-09-25-billing-qa/TEST-PLAN.md) —
// REG-MRR-ANNUAL (BD): a 6-tenant fixture pinning computeOverview()'s full aggregate output,
// including that an ANNUAL-cycle subscriber's basePriceSnapshot is already the catalog MONTHLY
// figure (never annual/12) — MrrService never even selects a `cycle` column, so it is naturally
// indifferent to billing interval and prices every row the same way.
describe("MrrService.computeOverview — REG-MRR-ANNUAL (6-tenant v11 fixture)", () => {
  it("T16 REG-B866-BYPLAN prices A(STARTER 99) B(GROWTH 249+addons) C(SCALE 499 fully discounted) D(manual, unpriced) E(addon-rescued) F(SCALE ANNUAL, snapshot=monthly 499) (flips REG-MRR-ANNUAL, SA-277)", async () => {
    const prisma = {
      tenantSubscription: {
        count: jest.fn().mockResolvedValue(0), // SA-736r: the unbilled-coupon cohort count
        findMany: jest.fn().mockResolvedValue([
          { tenantId: "A", planKey: "STARTER", basePriceSnapshot: 99, discount: 0 },
          { tenantId: "B", planKey: "GROWTH", basePriceSnapshot: 249, discount: 0 },
          // C: a real Stripe subscription (has a planKey + snapshot) fully discounted to $0.
          { tenantId: "C", planKey: "SCALE", basePriceSnapshot: 499, discount: 499 },
          // D: manual activation (activateManualSubscription never writes basePriceSnapshot —
          // REG-B557-MANUAL) — planKey resolved, snapshot null, no add-ons to rescue it.
          { tenantId: "D", planKey: "STARTER", basePriceSnapshot: null, discount: 0 },
          // E: null snapshot rescued above $0 by add-on revenue alone (REG-743-F4 shape) — put
          // on GROWTH so it never lands in the SCALE byPlan bucket this test also pins.
          { tenantId: "E", planKey: "GROWTH", basePriceSnapshot: null, discount: 0 },
          // F: ANNUAL-cycle subscriber — basePriceSnapshot is the catalog MONTHLY price (499),
          // never annual/12; MrrService's select never even reads `cycle`.
          { tenantId: "F", planKey: "SCALE", basePriceSnapshot: 499, discount: 0 },
        ]),
      },
      tenantAddon: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const all = [
            { tenantId: "B", priceSnapshot: 19, quantity: 1 }, // FORECASTING
            { tenantId: "B", priceSnapshot: 50, quantity: 2 }, // CUSTOMER_PACK_100 × 2
            { tenantId: "E", priceSnapshot: 39, quantity: 1 }, // REGULATED_ITEMS
          ];
          return Promise.resolve(
            where?.tenantId ? all.filter((a) => a.tenantId === where.tenantId) : all,
          );
        }),
      },
      tenant: { count: jest.fn().mockResolvedValue(0) },
      billingEvent: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: 0 } }) },
    } as any;

    const o = await new MrrService(prisma).computeOverview();

    expect(o.mrr).toBe(1005); // 99 + 368(B: 249+119) + 0(C) + 0(D) + 39(E) + 499(F)
    expect(o.baseMrr).toBe(1346); // Σ raw basePriceSnapshot: 99+249+499+0+0+499 (never net of discount) — P8
    expect(o.addonMrr).toBe(158); // B's 119 (19 + 50×2) + E's 39
    expect(o.discountTotal).toBe(499); // C's full discount
    expect(o.payingTenants).toBe(4); // A, B, E, F — each rowPrice > 0 — P8
    expect(o.unpricedActiveTenants).toBe(1); // D — null snapshot, no add-ons to rescue it — P8
    expect(o.zeroPricedActiveTenants).toBe(1); // C — has a snapshot, nets to $0 anyway — P8

    // byPlan is gross — the SAME formula as the top-level baseMrr accumulator (SA-277, B866):
    // for SCALE that's C(499) + F(499) = 998, not the pre-fix 499 (which wrongly subtracted
    // each row's discount a second time, C(499-499=0) + F(499-0=499)).
    expect(o.byPlan.find((p) => p.planKey === "SCALE")).toEqual({
      planKey: "SCALE",
      tenants: 1, // only F prices > 0; C nets to $0 and is excluded from the tenant count too
      baseMrr: 998,
    });

    // Identity pinned by SA-277: mrr = Σ rowPrice = baseMrr(gross) − discountTotal + addonMrr,
    // and byPlan's gross figures must sum back to the top-level gross baseMrr.
    expect(o.mrr).toBe(roundMoney(o.baseMrr - o.discountTotal + o.addonMrr));
    expect(o.byPlan.reduce((sum, p) => sum + p.baseMrr, 0)).toBe(o.baseMrr);
  });
});
