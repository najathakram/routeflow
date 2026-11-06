/**
 * SA-1099 A-4 (WP5, rows L-1 and L-4): `getSubscription` returns `alreadyHaveAddonSkus`, the self-serve SKUs the
 * workspace already has the effect of, so the add-on list can show "You already have this." instead of a price and a
 * Turn on button. The answer comes from ONE `authority.resolveAll` read through `addonOfferState`, the same helper the
 * enable's refusal calls, so the list and the sheet cannot disagree.
 *
 * L-1 runs through WP2's REAL evaluator (`FeatureResolverService`, `resolveOneKey`, `isCourtesyServed`); only the data
 * it reads is stubbed. L-4 is the guard: a resolver that cannot answer gives `[]` and a warning (never hide on a guess).
 */
import { Logger } from "@nestjs/common";
import { FeatureResolverService } from "./feature-resolver.service";
import { SubscriptionService } from "./subscription.service";

const FORECASTING = {
  sku: "FORECASTING",
  name: "Forecasting",
  monthlyPrice: 25,
  stackable: false,
  grantsFlags: ["flag.forecasting", "flag.analytics"],
  meteredKey: null,
  capacityPerUnit: null,
  includedAtPlan: null,
};
const PACK = {
  sku: "CUSTOMER_PACK_100",
  name: "Customer pack",
  monthlyPrice: 12,
  stackable: true,
  grantsFlags: [] as string[],
  meteredKey: "CUSTOMERS",
  capacityPerUnit: 100,
  includedAtPlan: null,
};

function make(o: {
  planKey: string;
  planFlags?: string[];
  heldSku?: boolean;
  resolverDown?: boolean;
}) {
  const planFlags = o.planFlags ?? [];
  const version = {
    id: "v1",
    status: "PUBLISHED",
    definitions: [
      { planKey: o.planKey, name: o.planKey, monthlyPrice: 0, featureFlags: planFlags },
    ],
    addonSkus: [FORECASTING, PACK],
  };
  const rows = o.heldSku
    ? [
        {
          addonKey: "FORECASTING",
          sku: "FORECASTING",
          active: true,
          isComp: false,
          quantity: 1,
          priceSnapshot: 25,
        },
      ]
    : [];
  const prisma: any = {
    tenantAddon: { findMany: jest.fn(async () => rows) },
    tenantSubscription: { findUnique: jest.fn(async () => null) },
    tenant: { findUnique: jest.fn(async () => ({ class: "PRODUCTION" })) },
  };
  const entitlements: any = {
    resolve: jest.fn(async () => ({
      planKey: o.planKey,
      planName: o.planKey,
      planVersionId: "v1",
      status: "ACTIVE",
      trialEndsAt: null,
      flags: planFlags,
      addons: [],
    })),
  };
  const catalog: any = {
    getVersionForTenant: jest.fn(async () => version),
    getPublishedVersion: jest.fn(async () => version),
  };
  const resolver = new FeatureResolverService(
    entitlements,
    {
      allActive: jest.fn(async () => new Map()),
      activeDetail: jest.fn(async () => new Map()),
    } as any,
    catalog,
    prisma,
  );
  const authority = {
    resolveAll: jest.fn((t: string) =>
      o.resolverDown ? Promise.resolve(null) : resolver.resolve(t),
    ),
  };
  const svc = new SubscriptionService(
    prisma,
    catalog,
    entitlements,
    { readAll: jest.fn(async () => []) } as any,
    undefined,
    undefined,
    undefined,
    authority as any,
  );
  return { svc, authority };
}

describe("L-1: getSubscription().alreadyHaveAddonSkus through the real WP2 evaluator", () => {
  const saved = process.env.PLAN_FLAG_ENFORCEMENT;
  beforeEach(() => delete process.env.PLAN_FLAG_ENFORCEMENT);
  afterAll(() => {
    if (saved === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = saved;
  });

  it("Starter, switch off: the courtesy serves both flags, so Forecasting is already had", async () => {
    const { svc } = make({ planKey: "STARTER" });
    expect((await svc.getSubscription("t1")).alreadyHaveAddonSkus).toEqual(["FORECASTING"]);
  });

  it("switch ON: no courtesy, nothing is served, the SKU is for sale", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const { svc } = make({ planKey: "STARTER" });
    expect((await svc.getSubscription("t1")).alreadyHaveAddonSkus).toEqual([]);
  });

  it("Lite is always enforced: no courtesy, for sale even with the switch off", async () => {
    const { svc } = make({ planKey: "LITE" });
    expect((await svc.getSubscription("t1")).alreadyHaveAddonSkus).toEqual([]);
  });

  it("a workspace holding an active FORECASTING row keeps the row (buy-more / disable): not in the set", async () => {
    const { svc } = make({ planKey: "STARTER", heldSku: true });
    expect((await svc.getSubscription("t1")).alreadyHaveAddonSkus).toEqual([]);
  });

  it("a plan that carries both flags: already had, whatever the switch says", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const { svc } = make({ planKey: "TEAM", planFlags: ["flag.forecasting", "flag.analytics"] });
    expect((await svc.getSubscription("t1")).alreadyHaveAddonSkus).toEqual(["FORECASTING"]);
  });

  it("the capacity SKU (customer pack) is never in the set, whatever the flags say", async () => {
    const { svc } = make({ planKey: "STARTER" });
    expect((await svc.getSubscription("t1")).alreadyHaveAddonSkus).not.toContain(
      "CUSTOMER_PACK_100",
    );
  });

  it("one cached resolver read per subscription load", async () => {
    const { svc, authority } = make({ planKey: "STARTER" });
    await svc.getSubscription("t1");
    expect(authority.resolveAll).toHaveBeenCalledTimes(1);
  });
});

describe("L-4: a resolver that cannot answer never hides a row", () => {
  it("resolveAll returns null: [] and a warning, the rest of the view is intact", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { svc } = make({ planKey: "STARTER", resolverDown: true });
      const view = await svc.getSubscription("t1");
      expect(view.alreadyHaveAddonSkus).toEqual([]);
      expect(view.planKey).toBe("STARTER");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("resolver could not answer"));
    } finally {
      warn.mockRestore();
    }
  });

  it("no authority wired (an older construction): [] and the view is unchanged", async () => {
    const { svc } = make({ planKey: "STARTER" });
    const bare = new SubscriptionService(
      (svc as any).prisma,
      (svc as any).catalog,
      (svc as any).entitlements,
      { readAll: jest.fn(async () => []) } as any,
    );
    expect((await bare.getSubscription("t1")).alreadyHaveAddonSkus).toEqual([]);
  });
});
