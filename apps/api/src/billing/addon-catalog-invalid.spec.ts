/**
 * B1102 (SA ruling): the READ paths of a stored catalog `includedAtPlan` FAIL CLOSED. A value no plan
 * answers to ("pro_typo") used to read as "bundled nowhere", so the add-on billed on every plan.
 *   - user-initiated readers (enable + its preview, checkout lines, the choose-plan quote, plan-change
 *     retirement) -> 409 ADDON_CATALOG_INVALID with { sku, value };
 *   - background readers (checkout adoption, manual activation, the catch-up dry-run) -> that add-on's
 *     Stripe item is NEVER created, the sku is logged, an audit row is written, nothing throws.
 * One parser (`resolveIncludedAtPlan`) feeds every reader.
 */
const mockWithAdvisoryLock = jest.fn(async () => {
  throw new Error("billing was attempted: the lock was reached");
});
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { ConflictException, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { addonCatalogInvalid } from "./addon-catalog-invalid";
import { addonsIncludedAtPlan } from "./addon-retirement";
import { priceUnbilledAddonsOnActivation } from "./manual-activation-addons";
import { beginStripeFirstPlanChange } from "./plan-change-flow";
import { resolveIncludedAtPlan } from "./plan-catalog.constants";
import { ProrationService } from "./proration.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";

const TYPO = "pro_typo";
const BAD = addonCatalogInvalid("FORECASTING", TYPO);

const catalogWith = (includedAtPlan: string | null) => ({
  definitions: [
    { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, annualPrice: 2490, isCustom: false },
    { planKey: "SCALE", name: "Scale", monthlyPrice: 499, annualPrice: 4990, isCustom: false },
  ],
  addonSkus: [{ sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19, includedAtPlan }],
});

const rejection = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => undefined,
    (e) => e,
  );

function makeSvc(includedAtPlan: string | null, planKey = "GROWTH") {
  const stripeClient = {
    products: { create: jest.fn().mockResolvedValue({ id: "prod_1" }) },
    subscriptionItems: {
      create: jest.fn().mockResolvedValue({ id: "si_new" }),
      list: jest.fn().mockResolvedValue({ data: [] }),
      update: jest.fn().mockResolvedValue({}),
      del: jest.fn().mockResolvedValue({}),
    },
    invoiceItems: { list: jest.fn().mockResolvedValue({ data: [] }) },
  };
  const audits: any[] = [];
  const auditTx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        audits.push(data);
        return {};
      }),
    },
  };
  const row = {
    id: "a1",
    addonKey: "FORECASTING",
    sku: "FORECASTING",
    active: true,
    quantity: 1,
    priceSnapshot: 0,
    stripeItemId: null,
    createdAt: new Date(1_790_000_000_000),
  };
  const prisma = {
    tenantAddon: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([row]),
    },
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ slug: "acme", name: "Acme Foods", plan: "STARTER" }),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({
        planKey,
        stripeSubId: "sub_t1",
        stripeCustomerId: "cus_t1",
        billingInterval: "month",
        cycle: "MONTHLY",
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(auditTx)),
  } as any;
  const cat = { getPublishedCatalog: jest.fn().mockResolvedValue(catalogWith(includedAtPlan)) };
  const svc = new SubscriptionMutationService(
    prisma,
    cat as any,
    { prorationPreview: jest.fn() } as any,
    { getSubscription: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn().mockResolvedValue({}) } as any,
    { invalidate: jest.fn() } as any,
    { isConfigured: true, client: stripeClient } as any,
    { notifyUpgradeConfirmed: jest.fn(), notifyDowngradeScheduled: jest.fn() } as any,
    { prepare: jest.fn(), onPlanChange: jest.fn() } as any,
  );
  return { svc, stripeClient, audits };
}

describe("B1102 one parser: resolveIncludedAtPlan", () => {
  it("null = never bundled; a current or legacy key resolves to the CURRENT plan; a typo is not ok", () => {
    expect(resolveIncludedAtPlan(null)).toEqual({ ok: true, plan: null });
    expect(resolveIncludedAtPlan(undefined)).toEqual({ ok: true, plan: null });
    expect(resolveIncludedAtPlan("SCALE")).toEqual({ ok: true, plan: "SCALE" });
    expect(resolveIncludedAtPlan("BUSINESS")).toEqual({ ok: true, plan: "SCALE" });
    expect(resolveIncludedAtPlan(TYPO)).toEqual({ ok: false });
  });
});

describe("B1102 user-initiated readers answer 409 ADDON_CATALOG_INVALID", () => {
  it("the refusal body carries the code, reason, sku and value", () => {
    expect(BAD).toMatchObject({
      code: API_ERROR_CODES.ADDON_CATALOG_INVALID,
      reason: "CATALOG_INVALID",
      sku: "FORECASTING",
      value: TYPO,
    });
  });

  it("enableAddon refuses before any lock, Stripe call or write", async () => {
    const { svc, stripeClient } = makeSvc(TYPO);
    const err = await rejection(svc.enableAddon("t1", "FORECASTING", 1, "u1"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(BAD);
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("the enable preview returns the SAME refusal object", async () => {
    const { svc } = makeSvc(TYPO);
    expect(await svc.addonEnableRefusal("t1", "FORECASTING")).toEqual(BAD);
  });

  it("checkoutAddonLines throws it on a user checkout", async () => {
    const { svc } = makeSvc(TYPO);
    const err = await rejection(svc.checkoutAddonLines("t1", "month"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(BAD);
  });

  it("the choose-plan quote throws it for a selected add-on", async () => {
    const cat = { getPublishedCatalog: jest.fn().mockResolvedValue(catalogWith(TYPO)) } as any;
    const svc = new ProrationService({} as any, cat);
    const err = await rejection(
      svc.quote({ planKey: "SCALE", cycle: "MONTHLY", addons: [{ sku: "FORECASTING" }] }),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(BAD);
  });

  it("plan-change retirement throws it for an add-on the tenant holds, not for one it does not", () => {
    const skus = [{ sku: "FORECASTING", name: "Forecasting", includedAtPlan: TYPO }];
    const held = { id: "a1", addonKey: "FORECASTING", sku: "FORECASTING", quantity: 1 };
    let err: any;
    try {
      addonsIncludedAtPlan([held], skus, "SCALE");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(BAD);
    expect(addonsIncludedAtPlan([], skus, "SCALE")).toEqual([]);
  });
});

describe("B1102 background readers skip the add-on, log, audit and never throw", () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it("checkout adoption (billUnbilledRow) creates NO Stripe item and does not throw", async () => {
    const { svc, stripeClient, audits } = makeSvc(TYPO);
    const row = { id: "a1", quantity: 1 };
    const billed = await (svc as any).billUnbilledRow("t1", "FORECASTING", row, "sub_t1", null, {});
    expect(billed).toBe(false);
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.products.create).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("FORECASTING"))).toBe(true);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("acme"))).toBe(false);
    expect(audits.map((a) => a.action)).toContain(AdminAuditAction.ADDON_CATALOG_INVALID);
  });

  it("the quiet catch-up read drops the add-on's line without throwing or writing a notice", async () => {
    const { svc, audits } = makeSvc(TYPO);
    const lines = await svc.checkoutAddonLines("t1", "month", { quiet: true });
    expect(lines).toEqual({
      lineItems: [],
      skus: [],
      invalid: [{ sku: "FORECASTING", value: TYPO }],
    });
    expect(audits).toEqual([]);
  });

  it("manual activation leaves the add-on unpriced and unbooked, with an audit row", async () => {
    const row = {
      id: "a1",
      tenantId: "t1",
      addonKey: "FORECASTING",
      sku: "FORECASTING",
      quantity: 1,
      active: true,
      priceSnapshot: 0,
      stripeItemId: null,
      createdAt: new Date(1_790_000_000_000),
    };
    const audits: any[] = [];
    const tx: any = {
      tenantAddon: {
        findMany: jest.fn().mockResolvedValue([row]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => {
          audits.push(data);
          return {};
        }),
      },
    };
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const done = await priceUnbilledAddonsOnActivation(tx, events, {
      tenantId: "t1",
      tenantLabel: "Acme",
      fromStatus: "TRIAL",
      planKey: "GROWTH",
      catalogAddons: catalogWith(TYPO).addonSkus,
    });
    expect(done).toEqual([]);
    expect(tx.tenantAddon.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(audits.map((a) => a.action)).toEqual([AdminAuditAction.ADDON_CATALOG_INVALID]);
  });
});

describe("B1102 a valid key is unchanged", () => {
  it("enable: bundled at SCALE -> the existing 'already included' refusal", async () => {
    const { svc } = makeSvc("SCALE", "SCALE");
    const err = await rejection(svc.enableAddon("t1", "FORECASTING", 1, "u1"));
    expect(err.getResponse()).toEqual({
      code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN,
      message: "Forecasting is already included in your plan.",
    });
  });

  it("enable preview: below the bundling plan -> no catalog refusal", async () => {
    const { svc } = makeSvc("SCALE", "GROWTH");
    const refusal = await svc.addonEnableRefusal("t1", "FORECASTING");
    expect(refusal?.code).not.toBe(API_ERROR_CODES.ADDON_CATALOG_INVALID);
  });

  it("quote: free at the bundling plan, billed below it", async () => {
    const cat = { getPublishedCatalog: jest.fn().mockResolvedValue(catalogWith("SCALE")) } as any;
    const svc = new ProrationService({} as any, cat);
    const at = await svc.quote({
      planKey: "SCALE",
      cycle: "MONTHLY",
      addons: [{ sku: "FORECASTING" }],
    });
    const below = await svc.quote({
      planKey: "GROWTH",
      cycle: "MONTHLY",
      addons: [{ sku: "FORECASTING" }],
    });
    expect(at.lines.find((l) => l.key === "FORECASTING")).toMatchObject({
      included: true,
      monthly: 0,
    });
    expect(below.lines.find((l) => l.key === "FORECASTING")).toMatchObject({
      included: false,
      monthly: 19,
    });
  });

  it("retirement: a held add-on bundled at the new plan is retired", () => {
    const skus = [{ sku: "FORECASTING", name: "Forecasting", includedAtPlan: "SCALE" }];
    const held = { id: "a1", addonKey: "FORECASTING", sku: "FORECASTING", quantity: 1 };
    expect(addonsIncludedAtPlan([held], skus, "SCALE").map((r) => r.code)).toEqual(["FORECASTING"]);
    expect(addonsIncludedAtPlan([held], skus, "GROWTH")).toEqual([]);
  });

  it("adoption: bundled at the plan -> skipped as before, and NO catalog-invalid audit", async () => {
    const { svc, stripeClient, audits } = makeSvc("SCALE", "SCALE");
    const billed = await (svc as any).billUnbilledRow(
      "t1",
      "FORECASTING",
      { id: "a1", quantity: 1 },
      "sub_t1",
      null,
      {},
    );
    expect(billed).toBe(false);
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });
});

describe("B1102 the empty value keeps its LEGACY meaning (never bundled), only a non-empty unknown value is invalid", () => {
  it('null and "" both resolve to "never bundled"; a non-empty unknown value is the only typo', () => {
    expect(resolveIncludedAtPlan(null)).toEqual({ ok: true, plan: null });
    expect(resolveIncludedAtPlan(undefined)).toEqual({ ok: true, plan: null });
    expect(resolveIncludedAtPlan("")).toEqual({ ok: true, plan: null });
    expect(resolveIncludedAtPlan(TYPO)).toEqual({ ok: false });
  });

  it('enable with includedAtPlan "" is NOT a catalog refusal (the SKU bills on every plan, as it always did)', async () => {
    const { svc } = makeSvc("");
    expect(await svc.addonEnableRefusal("t1", "FORECASTING")).toBeNull();
  });
});

describe("B1102 a Stripe-first plan change refuses a held invalid add-on before ANY Stripe call", () => {
  it("beginStripeFirstPlanChange throws the coded 409 and pushes nothing", async () => {
    const stripe = {
      subscriptions: { retrieve: jest.fn(), update: jest.fn() },
      subscriptionItems: { list: jest.fn(), del: jest.fn(), create: jest.fn() },
    };
    const prisma = {
      tenantAddon: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "a1",
            addonKey: "FORECASTING",
            sku: "FORECASTING",
            active: true,
            quantity: 1,
            stripeItemId: "si_1",
            isComp: false,
          },
        ]),
      },
    };
    const err = await rejection(
      beginStripeFirstPlanChange(
        { prisma: prisma as any, logger: new Logger("t"), stripe: stripe as any },
        {
          tenantId: "t1",
          stripeSubId: "sub_1",
          targetPlanKey: "SCALE",
          targetPlanName: "Scale",
          retireAddons: true,
          addonSkus: [{ sku: "FORECASTING", name: "Forecasting", includedAtPlan: TYPO }],
        } as any,
      ),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(BAD);
    for (const group of Object.values(stripe)) {
      for (const fn of Object.values(group)) expect(fn).not.toHaveBeenCalled();
    }
  });
});
