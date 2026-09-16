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
    expect(s.addons).toEqual([{ sku: "SEAT_EXTRA", name: "Extra seat", quantity: 2, monthly: 24 }]);
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
