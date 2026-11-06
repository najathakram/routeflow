/**
 * SA-1099 §6 (WP5, T22) through WP2's REAL evaluator: "Starter · buy Forecasting" is refused because the courtesy
 * already serves both flags, and is sold again the moment the courtesy is off (enforcement on), on an always-enforced
 * plan, or when the plan really lacks a flag. Only the data the resolver reads is stubbed (the tenant's entitlements,
 * overrides, catalog and add-on rows); `FeatureResolverService`, `resolveOneKey` and `isCourtesyServed` are the real
 * ones, and the enable call reads them through the same `resolveAll` the real authority exposes.
 */
const mockWithAdvisoryLock = jest.fn(
  async (_opts: { key: string }, _fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: { changed: true, proratedNow: 0, billing: "UNBILLED" },
  }),
);
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { ConflictException } from "@nestjs/common";
import { FeatureResolverService } from "./feature-resolver.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

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

function make(o: { planKey: string; planFlags: string[]; heldSku?: boolean }) {
  const version = {
    id: "v1",
    status: "PUBLISHED",
    definitions: [{ planKey: o.planKey, featureFlags: o.planFlags }],
    addonSkus: [FORECASTING],
  };
  const rows = o.heldSku
    ? [
        {
          addonKey: "FORECASTING",
          sku: "FORECASTING",
          active: true,
          isComp: false,
          priceSnapshot: 25,
        },
      ]
    : [];
  const prisma: any = {
    tenantAddon: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async () => rows[0] ?? null),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({ planKey: o.planKey, planVersionId: null }),
    },
    tenant: { findUnique: jest.fn().mockResolvedValue({ plan: o.planKey, planVersionId: null }) },
  };
  const resolver = new FeatureResolverService(
    {
      resolve: jest.fn(async () => ({
        planKey: o.planKey,
        planVersionId: "v1",
        flags: o.planFlags,
        addons: [],
      })),
    } as any,
    {
      allActive: jest.fn(async () => new Map()),
      activeDetail: jest.fn(async () => new Map()),
    } as any,
    {
      getVersionForTenant: jest.fn(async () => version),
      getPublishedVersion: jest.fn(async () => version),
    } as any,
    prisma,
  );
  const authority = {
    resolveAll: (t: string) => resolver.resolve(t),
    invalidate: (t: string) => resolver.invalidate(t),
    assertFeatureRequiresMet: jest.fn(async () => undefined),
  };
  const svc = new SubscriptionMutationService(
    prisma,
    { getPublishedCatalog: jest.fn().mockResolvedValue(version) } as any,
    {} as any,
    { getSubscription: jest.fn().mockResolvedValue({ planKey: o.planKey }) } as any,
    { invalidate: jest.fn() } as any,
    {} as any,
    {} as any,
    { isConfigured: false } as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    authority as any,
  );
  return svc;
}

describe("T22 through the real WP2 evaluator", () => {
  const saved = process.env.PLAN_FLAG_ENFORCEMENT;
  beforeEach(() => {
    mockWithAdvisoryLock.mockClear();
    delete process.env.PLAN_FLAG_ENFORCEMENT;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = saved;
  });

  it("Starter, enforcement off: the courtesy serves both flags, so buying Forecasting is 409 ADDON_ALREADY_INCLUDED", async () => {
    const svc = make({ planKey: "STARTER", planFlags: [] });
    const err: any = await svc.enableAddon("t1", "FORECASTING", 1, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED,
      message: "You already have Forecasting, so there is nothing to buy.",
    });
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
  });

  it("the preview returns the same refusal", async () => {
    const svc = make({ planKey: "STARTER", planFlags: [] });
    expect(await svc.addonEnableRefusal("t1", "FORECASTING")).toMatchObject({
      code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED,
    });
  });

  it("Starter, enforcement ON: the courtesy is gone, nothing is served, the purchase goes ahead", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const svc = make({ planKey: "STARTER", planFlags: [] });
    await expect(svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("Lite is always enforced, so no courtesy: the purchase goes ahead even with enforcement off", async () => {
    const svc = make({ planKey: "LITE", planFlags: [] });
    await expect(svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("a plan that carries both flags: refused whatever the enforcement switch says", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const svc = make({ planKey: "TEAM", planFlags: ["flag.forecasting", "flag.analytics"] });
    await expect(svc.enableAddon("t1", "FORECASTING", 1, "u1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED },
    });
  });

  it("a plan that carries only one of the two flags, enforcement on: still sells (it adds the other)", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const svc = make({ planKey: "TEAM", planFlags: ["flag.forecasting"] });
    await expect(svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
  });

  it("a workspace that already holds the Forecasting row is not refused (the idempotent path stays)", async () => {
    const svc = make({ planKey: "STARTER", planFlags: [], heldSku: true });
    await expect(svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
  });
});
