import { BadRequestException } from "@nestjs/common";
import { SubscriptionService } from "./subscription.service";
import { pinWallClock } from "../testing/pin-clock";

/**
 * SA-1547 PR-3 R4 (the wire carries what the confirm prints): `getSubscription` returns `selfPay` with the plan
 * name, the server price, the add-on lines and the anchor the slot would use. Every figure is server-made; the
 * web does no arithmetic.
 */
const PINNED = "2026-11-15T09:00:00Z";

function build(opts: {
  status?: string;
  readOnlyReason?: string | null;
  planKey?: string;
  stripeSubId?: string | null;
  priceOverrideMonthly?: number | null;
  addonPrice?: number;
  addonQty?: number;
  pricing?: { resolveTenantPricing: jest.Mock };
}) {
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({
      definitions: [{ planKey: "STARTER", monthlyPrice: 99, annualPrice: 990, isCustom: false }],
      addonSkus: [{ sku: "FORECASTING", name: "Forecasting", monthlyPrice: opts.addonPrice ?? 25 }],
    }),
  } as any;
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ class: "PRODUCTION", deletedAt: null }) },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({
        stripeSubId: opts.stripeSubId ?? null,
        externalPayment: false,
        couponFull: false,
        priceOverrideMonthly: opts.priceOverrideMonthly ?? null,
      }),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue([
        {
          sku: "FORECASTING",
          addonKey: "FORECASTING",
          quantity: opts.addonQty ?? 2,
          isComp: false,
          active: true,
        },
      ]),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const entitlements = {
    resolve: jest.fn().mockResolvedValue({
      planKey: opts.planKey ?? "STARTER",
      planName: "Starter",
      status: opts.status ?? "READ_ONLY",
      readOnlyReason: opts.readOnlyReason === undefined ? "trial_expired" : opts.readOnlyReason,
      planVersionId: "v7",
      trialEndsAt: null,
    }),
  } as any;
  return new SubscriptionService(
    prisma,
    catalog,
    entitlements,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.pricing as any,
  );
}

describe("SubscriptionService.getSubscription: selfPay (R4)", () => {
  beforeEach(() => pinWallClock(PINNED));
  afterEach(() => jest.useRealTimers());

  it("a trial-expired business: eligible, with plan name, server price, add-on lines and the anchor", async () => {
    const view = await build({}).getSubscription("t1");
    expect(view.selfPay).toEqual({
      eligible: true,
      reason: "trial_expired",
      planKey: "STARTER",
      planName: "Starter",
      monthly: 99,
      addons: [{ name: "Forecasting", monthly: 50 }],
      firstFullChargeAt: new Date("2026-12-01T12:00:00.000Z"),
    });
  });

  it("a custom fee is the price the confirm prints (the quoted fee, never the catalog figure)", async () => {
    const view = await build({ priceOverrideMonthly: 79 }).getSubscription("t1");
    expect(view.selfPay?.monthly).toBe(79);
  });

  it("M2: every money value on the wire is rounded once (an add-on line of 0.1 x 3 is 0.3, not 0.30000000000000004)", async () => {
    const view = await build({ addonPrice: 0.1, addonQty: 3 }).getSubscription("t1");
    expect(view.selfPay?.addons).toEqual([{ name: "Forecasting", monthly: 0.3 }]);
  });

  it("L3: the price printed is the one checkout bills (resolveTenantPricing), not a re-derivation", async () => {
    const pricing = {
      resolveTenantPricing: jest.fn().mockResolvedValue({ monthly: 88.005, planKey: "STARTER" }),
    };
    const view = await build({ pricing }).getSubscription("t1");
    expect(pricing.resolveTenantPricing).toHaveBeenCalledWith("t1");
    expect(view.selfPay?.monthly).toBe(88.01);
  });

  it("L3: a business the resolver cannot price (a business refusal) is not eligible: no_price", async () => {
    const pricing = {
      resolveTenantPricing: jest.fn().mockRejectedValue(new BadRequestException("no price")),
    };
    const view = await build({ pricing }).getSubscription("t1");
    expect(view.selfPay).toMatchObject({ eligible: false, reason: "no_price", monthly: null });
  });

  it("L3: a business that cannot pay anyway (ACTIVE) never calls the resolver", async () => {
    const pricing = { resolveTenantPricing: jest.fn() };
    await build({ pricing, status: "ACTIVE", readOnlyReason: null }).getSubscription("t1");
    expect(pricing.resolveTenantPricing).not.toHaveBeenCalled();
  });

  it("R1: a TRIAL business with days left gets selfPay.eligible false", async () => {
    const view = await build({ status: "TRIAL", readOnlyReason: null }).getSubscription("t1");
    expect(view.selfPay).toMatchObject({ eligible: false, reason: "trial_active" });
  });

  it("a business with a Stripe subscription id is not eligible", async () => {
    const view = await build({ stripeSubId: "sub_1" }).getSubscription("t1");
    expect(view.selfPay).toMatchObject({ eligible: false, reason: "live_subscription" });
  });

  it("inside the 91-minute window the anchor shown is the one the slot will use once it reopens (the 1st after)", async () => {
    jest.useRealTimers();
    pinWallClock("2026-12-01T11:00:00Z");
    const view = await build({}).getSubscription("t1");
    expect(view.selfPay?.firstFullChargeAt).toEqual(new Date("2027-01-01T12:00:00.000Z"));
  });
});
