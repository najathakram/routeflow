import { SubscriptionService } from "./subscription.service";

const DEFS = [
  {
    planKey: "STARTER",
    name: "Starter",
    monthlyPrice: 59,
    seatsIncluded: 1,
    routesConcurrent: 1,
    scansIncluded: 20,
    msgsIncluded: 200,
    isCustom: false,
    sortOrder: 0,
  },
  {
    planKey: "TEAM",
    name: "Team",
    monthlyPrice: 149,
    seatsIncluded: 5,
    routesConcurrent: 3,
    scansIncluded: 100,
    msgsIncluded: 200,
    isCustom: false,
    sortOrder: 1,
  },
  {
    planKey: "BUSINESS",
    name: "Business",
    monthlyPrice: 349,
    seatsIncluded: 15,
    routesConcurrent: null,
    scansIncluded: 300,
    msgsIncluded: 200,
    isCustom: false,
    sortOrder: 2,
  },
  {
    planKey: "ENTERPRISE",
    name: "Enterprise",
    monthlyPrice: null,
    seatsIncluded: null,
    routesConcurrent: null,
    scansIncluded: null,
    msgsIncluded: 200,
    isCustom: true,
    sortOrder: 3,
  },
];

function makeService(usage: { SEATS: number; ROUTES: number; SCANS: number; MSGS: number }) {
  const readings = (["SEATS", "ROUTES", "SCANS", "MSGS"] as const).map((m) => ({
    meter: m,
    used: usage[m],
    included: null,
    remaining: null,
    resetsAt: null,
  }));
  const meters = { readAll: jest.fn().mockResolvedValue(readings) } as any;
  const catalog = {
    getPublishedCatalog: jest.fn().mockResolvedValue({ definitions: DEFS, addonSkus: [] }),
  } as any;
  const entitlements = {
    resolve: jest.fn().mockResolvedValue({ planKey: "STARTER", addons: [] }),
  } as any;
  const prisma = {} as any;
  return new SubscriptionService(prisma, catalog, entitlements, meters);
}

describe("SubscriptionService.getRecommendation", () => {
  it("recommends the cheapest plan that fits current usage (Starter)", async () => {
    const r = await makeService({ SEATS: 1, ROUTES: 1, SCANS: 5, MSGS: 10 }).getRecommendation(
      "t1",
    );
    expect(r.recommendedPlanKey).toBe("STARTER");
    expect(r.perPlan.find((p) => p.planKey === "STARTER")!.fits).toBe(true);
  });

  it("steps up to Team when seats exceed the Starter cap", async () => {
    const r = await makeService({ SEATS: 3, ROUTES: 1, SCANS: 5, MSGS: 10 }).getRecommendation(
      "t1",
    );
    expect(r.perPlan.find((p) => p.planKey === "STARTER")!.fits).toBe(false);
    expect(r.perPlan.find((p) => p.planKey === "STARTER")!.over.seats).toBe(2);
    expect(r.recommendedPlanKey).toBe("TEAM");
  });

  it("treats unlimited (null) caps as always-fitting and lands on Enterprise for huge usage", async () => {
    const r = await makeService({
      SEATS: 999,
      ROUTES: 999,
      SCANS: 9999,
      MSGS: 9999,
    }).getRecommendation("t1");
    // Business has unlimited routes but finite seats(15)/scans(300) → doesn't fit; only Enterprise fits.
    expect(r.perPlan.find((p) => p.planKey === "BUSINESS")!.fits).toBe(false);
    expect(r.recommendedPlanKey).toBe("ENTERPRISE");
  });

  it("reports over-cap deltas as 0 for unlimited caps", async () => {
    const r = await makeService({
      SEATS: 999,
      ROUTES: 999,
      SCANS: 100,
      MSGS: 100,
    }).getRecommendation("t1");
    // Business.routesConcurrent is null (unlimited) → over.routes must be 0 despite 999 usage.
    expect(r.perPlan.find((p) => p.planKey === "BUSINESS")!.over.routes).toBe(0);
  });
});

describe("SubscriptionService.getSubscription", () => {
  it("returns the current plan + active add-ons with prices", async () => {
    const catalog = {
      getVersionForTenant: jest.fn().mockResolvedValue({
        definitions: DEFS,
        addonSkus: [{ sku: "SEAT_EXTRA", name: "Extra seat", monthlyPrice: 12 }],
      }),
    } as any;
    const entitlements = {
      resolve: jest.fn().mockResolvedValue({
        planKey: "TEAM",
        planName: "Team",
        status: "ACTIVE",
        planVersionId: "v7",
        trialEndsAt: null,
      }),
    } as any;
    const prisma = {
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          cycle: "ANNUAL",
          periodEnd: new Date("2027-07-08"),
          cancelAtPeriodEnd: false,
        }),
      },
      tenantAddon: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { addonKey: "seat_extra", sku: "SEAT_EXTRA", quantity: 2, active: true },
          ]),
      },
    } as any;
    const meters = {} as any;
    const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

    const s = await svc.getSubscription("t1");
    expect(s.planKey).toBe("TEAM");
    expect(s.cycle).toBe("ANNUAL");
    expect(s.monthlyPrice).toBe(149);
    expect(s.annualPrice).toBeNull(); // DEFS omits annualPrice → null-safe
    expect(s.addons).toEqual([
      { sku: "SEAT_EXTRA", name: "Extra seat", quantity: 2, comp: false, monthly: 24 },
    ]);
  });

  // Row 350 / SA-693: a comp add-on (TenantAddon.isComp) is granted free and never billed, so the tenant's
  // add-on list must say so (`comp: true`) and never carry a price for it.
  describe("row 350: comp add-ons are labelled and never priced", () => {
    function makeFor(addonRows: Array<Record<string, unknown>>) {
      const catalog = {
        getVersionForTenant: jest.fn().mockResolvedValue({
          definitions: DEFS,
          addonSkus: [
            { sku: "SEAT_EXTRA", name: "Extra seat", monthlyPrice: 12 },
            { sku: "SALES_AGENTS", name: "Sales agents", monthlyPrice: 49 },
          ],
        }),
      } as any;
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "TEAM",
          planName: "Team",
          status: "ACTIVE",
          planVersionId: "v7",
          trialEndsAt: null,
        }),
      } as any;
      const prisma = {
        tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
        tenantAddon: { findMany: jest.fn().mockResolvedValue(addonRows) },
      } as any;
      return new SubscriptionService(prisma, catalog, entitlements, {} as any);
    }

    it("a comp row carries comp:true and a null monthly, never price x quantity", async () => {
      const s = await makeFor([
        { addonKey: "sales_agents", sku: "SALES_AGENTS", quantity: 1, active: true, isComp: true },
      ]).getSubscription("t1");
      expect(s.addons).toEqual([
        { sku: "SALES_AGENTS", name: "Sales agents", quantity: 1, comp: true, monthly: null },
      ]);
    });

    it("a paid row beside a comp row keeps price x quantity and comp:false", async () => {
      const s = await makeFor([
        { addonKey: "seat_extra", sku: "SEAT_EXTRA", quantity: 3, active: true, isComp: false },
        { addonKey: "sales_agents", sku: "SALES_AGENTS", quantity: 1, active: true, isComp: true },
      ]).getSubscription("t1");
      expect(s.addons.map((a) => [a.sku, a.comp, a.monthly])).toEqual([
        ["SEAT_EXTRA", false, 36],
        ["SALES_AGENTS", true, null],
      ]);
      // Anything that sums the list (a total, an export) must see the comp as 0.
      expect(s.addons.reduce((sum, a) => sum + (a.monthly ?? 0), 0)).toBe(36);
    });

    it("a comp whose sku is not in the catalog is still comp:true with a null monthly", async () => {
      const s = await makeFor([
        { addonKey: "legacy_thing", sku: null, quantity: 1, active: true, isComp: true },
      ]).getSubscription("t1");
      expect(s.addons).toHaveLength(1);
      expect(s.addons[0]).toMatchObject({ comp: true, monthly: null });
    });

    it("an unknown-sku paid row stays comp:false with a null monthly", async () => {
      const s = await makeFor([
        { addonKey: "legacy_thing", sku: null, quantity: 1, active: true, isComp: false },
      ]).getSubscription("t1");
      expect(s.addons[0]).toMatchObject({ comp: false, monthly: null });
    });
  });

  // Feature-grants PR-1 (owner ruling 2026-09-16, Opus review fix 1): this IS the web's actual
  // flag-gating read path (usePlanFlag → useSubscription().flags) — an active override must be
  // absolute here too, or a GRANT is invisible (nav stays hidden) and a DENY dead-ends (nav
  // shown, every call 403s).
  describe("feature-grants PR-1: override merge", () => {
    function baseFixtures(planKey: string, planFlags: string[]) {
      const catalog = {
        getVersionForTenant: jest.fn().mockResolvedValue({ definitions: DEFS, addonSkus: [] }),
      } as any;
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey,
          planName: planKey,
          status: "ACTIVE",
          planVersionId: "v7",
          trialEndsAt: null,
          flags: planFlags,
        }),
      } as any;
      const prisma = {
        tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
        tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;
      const meters = {} as any;
      return { catalog, entitlements, prisma, meters };
    }

    it("a GRANT override on a LITE tenant surfaces a flag the plan doesn't grant", async () => {
      const { catalog, entitlements, prisma, meters } = baseFixtures("LITE", []);
      const featureOverrides = {
        allActive: jest.fn().mockResolvedValue(new Map([["flag.msrp", "GRANT"]])),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters, featureOverrides);

      const s = await svc.getSubscription("t1");
      expect(s.flags).toContain("flag.msrp");
    });

    it("a DENY override on a GROWTH tenant removes a flag the plan grants", async () => {
      const { catalog, entitlements, prisma, meters } = baseFixtures("GROWTH", ["flag.msrp"]);
      const featureOverrides = {
        allActive: jest.fn().mockResolvedValue(new Map([["flag.msrp", "DENY"]])),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters, featureOverrides);

      const s = await svc.getSubscription("t1");
      expect(s.flags).not.toContain("flag.msrp");
    });

    it("an addon-keyed override is never merged into flags (gateVia filter)", async () => {
      const { catalog, entitlements, prisma, meters } = baseFixtures("GROWTH", []);
      const featureOverrides = {
        allActive: jest.fn().mockResolvedValue(new Map([["tobacco_dealer", "GRANT"]])),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters, featureOverrides);

      const s = await svc.getSubscription("t1");
      expect(s.flags).not.toContain("tobacco_dealer");
    });

    it("no featureOverrides collaborator (the 4-arg form) behaves exactly as before", async () => {
      const { catalog, entitlements, prisma, meters } = baseFixtures("GROWTH", ["flag.msrp"]);
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

      const s = await svc.getSubscription("t1");
      expect(s.flags).toContain("flag.msrp");
    });
  });

  // RO-1: settings-billing + a future dashboard-wide banner both need to know WHY a tenant
  // is read-only (trial_expired vs. subscription_cancelled vs. trial_cancelled) — today the
  // view exposes only the raw `status` enum, never the reason sub-field.
  it("RO-1 the subscription view carries the tenant's readOnlyReason", async () => {
    const catalog = {
      getVersionForTenant: jest.fn().mockResolvedValue({ definitions: DEFS, addonSkus: [] }),
    } as any;
    const prisma = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const meters = {} as any;

    const readOnlyEntitlements = {
      planKey: "STARTER",
      planName: "Starter",
      status: "READ_ONLY",
      planVersionId: "v7",
      trialEndsAt: null,
      readOnlyReason: "trial_expired",
    };
    const readOnlySvc = new SubscriptionService(
      prisma,
      catalog,
      { resolve: jest.fn().mockResolvedValue(readOnlyEntitlements) } as any,
      meters,
    );
    const readOnlyView = await readOnlySvc.getSubscription("t-1");
    expect(readOnlyView.readOnlyReason).toBe("trial_expired");

    const activeSvc = new SubscriptionService(
      prisma,
      catalog,
      {
        resolve: jest
          .fn()
          .mockResolvedValue({ ...readOnlyEntitlements, status: "ACTIVE", readOnlyReason: null }),
      } as any,
      meters,
    );
    const activeView = await activeSvc.getSubscription("t-1");
    expect(activeView.readOnlyReason).toBeNull();
  });

  // WP3c (R1.7, R2.5): the settings-billing view now also carries the tenant's
  // effective flag set (its own stored flags union dark-flag courtesy allows) and a
  // structural paymentRequired signal for an invited-but-unpaid invite-only plan.
  describe("WP3c flags + paymentRequired", () => {
    const catalog = {
      getVersionForTenant: jest.fn().mockResolvedValue({ definitions: DEFS, addonSkus: [] }),
    } as any;
    const prisma = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const meters = {} as any;

    it("unions the entitlement's own flags into the returned flags set, deduped", async () => {
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "STARTER",
          planName: "Starter",
          status: "ACTIVE",
          planVersionId: "v7",
          trialEndsAt: null,
          // Already carries a dark flag (redundant with the courtesy allow) plus one
          // flag that is NOT dark-listed (flag.msrp) — both must survive into `flags`.
          flags: ["flag.reports", "flag.msrp"],
        }),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

      const s = await svc.getSubscription("t1");

      expect(s.flags).toContain("flag.reports");
      expect(s.flags).toContain("flag.msrp");
      // Deduped — flag.reports isn't listed twice even though it's both a dark-flag
      // courtesy allow AND explicitly stored on the entitlement.
      expect(s.flags.filter((f: string) => f === "flag.reports")).toHaveLength(1);
    });

    describe("P0 2026-09-17: PREPIN_DARK_FLAGS surfaced in the client-visible flags list", () => {
      const originalEnforcement = process.env.PLAN_FLAG_ENFORCEMENT;
      afterEach(() => {
        if (originalEnforcement === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
        else process.env.PLAN_FLAG_ENFORCEMENT = originalEnforcement;
      });

      it("a SCALE tenant on the v11 catalog (no prepin flags held) sees all five in flags with enforcement ON", async () => {
        process.env.PLAN_FLAG_ENFORCEMENT = "on";
        const entitlements = {
          resolve: jest.fn().mockResolvedValue({
            planKey: "SCALE",
            planName: "Scale",
            status: "ACTIVE",
            planVersionId: "v11",
            trialEndsAt: null,
            flags: [],
          }),
        } as any;
        const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

        const s = await svc.getSubscription("t1");

        for (const flagKey of [
          "flag.estimates",
          "flag.recurring_invoices",
          "flag.credit_notes",
          "flag.suppliers",
          "flag.messaging",
        ]) {
          expect(s.flags).toContain(flagKey);
        }
      });

      it("a LITE tenant does NOT see the five unless actually held, even with enforcement ON (no courtesy allow for always-enforced plans)", async () => {
        process.env.PLAN_FLAG_ENFORCEMENT = "on";
        const entitlements = {
          resolve: jest.fn().mockResolvedValue({
            planKey: "LITE",
            planName: "Lite",
            status: "ACTIVE",
            planVersionId: "v11",
            trialEndsAt: null,
            flags: [],
          }),
        } as any;
        const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

        const s = await svc.getSubscription("t1");

        expect(s.flags).not.toContain("flag.estimates");
      });
    });

    it("still resolves flags when the entitlements mock omits `flags` entirely (defensive fallback)", async () => {
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "STARTER",
          planName: "Starter",
          status: "ACTIVE",
          planVersionId: "v7",
          trialEndsAt: null,
        }),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

      const s = await svc.getSubscription("t1");

      expect(Array.isArray(s.flags)).toBe(true);
    });

    it("paymentRequired is true for an invited LITE tenant that hasn't completed checkout yet", async () => {
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "LITE",
          planName: "Lite",
          status: "TRIAL",
          planVersionId: "v7",
          trialEndsAt: null,
          flags: [],
        }),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

      const s = await svc.getSubscription("t1");

      expect(s.paymentRequired).toBe(true);
    });

    it("paymentRequired is false once the LITE tenant is ACTIVE (checkout completed)", async () => {
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "LITE",
          planName: "Lite",
          status: "ACTIVE",
          planVersionId: "v7",
          trialEndsAt: null,
          flags: [],
        }),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

      const s = await svc.getSubscription("t1");

      expect(s.paymentRequired).toBe(false);
    });

    // B449 fix-round finding 7 (Opus re-review, ruled a false alarm): the client
    // (RouteGuard/PlanGateBoundary/usePlanFlag) reads `subscription.flags` and does a
    // bare `.includes(key)` with no dark-flag-policy awareness of its own. This pins
    // WHY that's already correct and needs no client-side `allowsFlag` mirror: the
    // dark-flag courtesy allow (plan-flag-policy.ts) is baked into `flags` HERE, once,
    // server-side — not left for each consumer to re-derive.
    it("bakes the dark-flag courtesy allow into flags for a non-always-enforced plan, but not for LITE (why the client needs no allowsFlag mirror)", async () => {
      // v11's GROWTH definition (plan-catalog-v11.definitions.ts) does not grant
      // flag.estimates — it's a Lite-L2 flag with no catalog row on v11 at all — yet
      // flag.estimates IS in DARK_PLAN_FLAGS and GROWTH is not in
      // ALWAYS_ENFORCED_PLAN_KEYS, so the courtesy allow must still grant it.
      const growthEntitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "GROWTH",
          planName: "Growth",
          status: "ACTIVE",
          planVersionId: "v11",
          trialEndsAt: null,
          flags: ["flag.reports"],
        }),
      } as any;
      const growthSvc = new SubscriptionService(prisma, catalog, growthEntitlements, meters);
      const growthView = await growthSvc.getSubscription("t1");
      expect(growthView.flags).toContain("flag.estimates");

      // LITE is the one entry in ALWAYS_ENFORCED_PLAN_KEYS — it gets NO courtesy allow,
      // so an ungranted dark flag stays ungranted (this is the enforcement Lite-L2 exists
      // to ship; the courtesy allow above must never leak onto it).
      const liteEntitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "LITE",
          planName: "Lite",
          status: "ACTIVE",
          planVersionId: "v12",
          trialEndsAt: null,
          flags: [],
        }),
      } as any;
      const liteSvc = new SubscriptionService(prisma, catalog, liteEntitlements, meters);
      const liteView = await liteSvc.getSubscription("t1");
      expect(liteView.flags).not.toContain("flag.estimates");
    });

    it("paymentRequired is false for a non-invite-only plan regardless of status", async () => {
      const entitlements = {
        resolve: jest.fn().mockResolvedValue({
          planKey: "STARTER",
          planName: "Starter",
          status: "READ_ONLY",
          planVersionId: "v7",
          trialEndsAt: null,
          flags: [],
        }),
      } as any;
      const svc = new SubscriptionService(prisma, catalog, entitlements, meters);

      const s = await svc.getSubscription("t1");

      expect(s.paymentRequired).toBe(false);
    });
  });
});

// SA-733r6 (B4): the view carries the dunning facts + the extras the banner needs, so the web renders from ONE read.
describe("SubscriptionService.getSubscription - B4 banner fields", () => {
  function build(sub: any, extrasOut: any) {
    const catalog = {
      getVersionForTenant: jest.fn().mockResolvedValue({ definitions: DEFS, addonSkus: [] }),
    } as any;
    const entitlements = {
      resolve: jest.fn().mockResolvedValue({
        planKey: "TEAM",
        planName: "Team",
        status: "READ_ONLY",
        planVersionId: "v7",
        trialEndsAt: null,
        readOnlyReason: "payment_overdue",
      }),
    } as any;
    const prisma = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue(sub) },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const extras = { read: jest.fn().mockResolvedValue(extrasOut) } as any;
    const svc = new SubscriptionService(
      prisma,
      catalog,
      entitlements,
      {} as any,
      undefined,
      extras,
    );
    return { svc, extras };
  }

  it("returns pastDueSince, pastDueInvoiceId, billingContactEmail, openInvoiceAmount, card and next charge", async () => {
    const sub = {
      cycle: "MONTHLY",
      periodEnd: new Date("2026-12-01T00:00:00Z"),
      pastDueSince: new Date("2026-11-01T14:00:00Z"),
      pastDueInvoiceId: "in_1",
      pausedAt: new Date("2026-11-08T09:00:00Z"),
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    };
    const extrasOut = {
      billingContactEmail: "dana@acme.test",
      openInvoiceAmount: 149,
      paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 10, expYear: 2026 },
      nextCharge: { amount: 149, date: "2026-12-01T00:00:00.000Z" },
    };
    const { svc, extras } = build(sub, extrasOut);

    const view = await svc.getSubscription("t1");

    expect(view.pastDueSince).toEqual(new Date("2026-11-01T14:00:00Z"));
    expect(view.pastDueInvoiceId).toBe("in_1");
    expect(view).not.toHaveProperty("billingContactName");
    expect(view.billingContactEmail).toBe("dana@acme.test");
    expect(view.openInvoiceAmount).toBe(149);
    expect(view.paymentMethodSummary).toEqual(extrasOut.paymentMethodSummary);
    expect(view.nextCharge).toEqual(extrasOut.nextCharge);
    expect(extras.read).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ pastDueInvoiceId: "in_1" }),
    );
  });

  it("a tenant that never failed a payment has null dunning fields (an old shape sees the autopay card only)", async () => {
    const { svc } = build(
      { cycle: "MONTHLY", periodEnd: null, pastDueSince: null, pastDueInvoiceId: null },
      {
        billingContactEmail: "dana@acme.test",
        openInvoiceAmount: null,
        paymentMethodSummary: null,
        nextCharge: null,
      },
    );
    const view = await svc.getSubscription("t1");
    expect(view.pastDueSince).toBeNull();
    expect(view.pastDueInvoiceId).toBeNull();
    expect(view.openInvoiceAmount).toBeNull();
  });

  it("without the extras collaborator the new fields are null (the 5-arg form keeps working)", async () => {
    const catalog = {
      getVersionForTenant: jest.fn().mockResolvedValue({ definitions: DEFS, addonSkus: [] }),
    } as any;
    const prisma = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const svc = new SubscriptionService(
      prisma,
      catalog,
      {
        resolve: jest
          .fn()
          .mockResolvedValue({ planKey: "TEAM", status: "ACTIVE", planVersionId: "v7" }),
      } as any,
      {} as any,
    );
    const view = await svc.getSubscription("t1");
    expect(view.billingContactEmail).toBeNull();
    expect(view.openInvoiceAmount).toBeNull();
    expect(view.paymentMethodSummary).toBeNull();
  });
});

describe("SubscriptionService.openInvoiceUrl", () => {
  it("is the hosted URL of the pastDueInvoiceId invoice, null when nothing is owed", async () => {
    const extras = {
      hostedInvoiceUrl: jest.fn().mockResolvedValue("https://invoice.example/i/1"),
    } as any;
    const prismaOwed = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue({ pastDueInvoiceId: "in_1" }) },
    } as any;
    const owed = new SubscriptionService(
      prismaOwed,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      extras,
    );
    expect(await owed.openInvoiceUrl("t1")).toBe("https://invoice.example/i/1");
    expect(extras.hostedInvoiceUrl).toHaveBeenCalledWith("in_1");

    const prismaNone = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue({ pastDueInvoiceId: null }) },
    } as any;
    const none = new SubscriptionService(
      prismaNone,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      extras,
    );
    expect(await none.openInvoiceUrl("t1")).toBeNull();
  });
});
