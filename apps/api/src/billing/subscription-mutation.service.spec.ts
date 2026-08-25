import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

function catalog() {
  return {
    id: "v7",
    definitions: [
      { planKey: "STARTER", name: "Starter", monthlyPrice: 59, isCustom: false },
      { planKey: "TEAM", name: "Team", monthlyPrice: 149, isCustom: false },
      { planKey: "BUSINESS", name: "Business", monthlyPrice: 349, isCustom: false },
      { planKey: "ENTERPRISE", name: "Enterprise", monthlyPrice: null, isCustom: true },
    ],
    addonSkus: [
      { sku: "SEAT_EXTRA", name: "Extra seat", monthlyPrice: 12 },
      { sku: "BUYER_PORTAL", name: "Buyer portal", monthlyPrice: 49 },
      { sku: "REGULATED_ITEMS", name: "Regulated", monthlyPrice: 39 },
      // Self-service SKUs (SELF_SERVICE_ADDON_SKUS) — the only two enableAddon may grant.
      { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12 },
      { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25 },
      // Admin-only SKUs — enableAddon must 403 a self-service request for these.
      { sku: "MSRP", name: "MSRP", monthlyPrice: 20 },
      { sku: "SALES_AGENTS", name: "Sales agents", monthlyPrice: 30 },
    ],
  };
}

/** Post-rename catalog (v8) — GROWTH/SCALE have NO matching Prisma TenantPlan enum member. */
function catalogV8() {
  return {
    id: "v8",
    definitions: [
      { planKey: "STARTER", name: "Starter", monthlyPrice: 99, isCustom: false },
      { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, isCustom: false },
      { planKey: "SCALE", name: "Scale", monthlyPrice: 499, isCustom: false },
      { planKey: "ENTERPRISE", name: "Enterprise", monthlyPrice: null, isCustom: true },
    ],
    addonSkus: [],
  };
}

interface Opts {
  catalog?: ReturnType<typeof catalog>;
  tenantStatus?: string;
  sub?: any;
  priorAddons?: any[];
  existingAddon?: any;
  addonRow?: any;
}

function make(opts: Opts = {}) {
  const tx = {
    tenantSubscription: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tenant: { update: jest.fn().mockResolvedValue({}) },
    tenantAddon: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ status: opts.tenantStatus ?? "TRIAL" }) },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.sub ?? null),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(opts.priorAddons ?? []),
      findUnique: jest.fn().mockResolvedValue(opts.existingAddon ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.addonRow ?? null),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  const cat = {
    getPublishedCatalog: jest.fn().mockResolvedValue(opts.catalog ?? catalog()),
  } as any;
  const proration = {
    quote: jest.fn().mockResolvedValue({ subtotalMonthly: 173, lines: [] }),
    prorationPreview: jest.fn().mockResolvedValue({ proratedToday: 6.4 }),
  } as any;
  const subscription = { getSubscription: jest.fn().mockResolvedValue({ planKey: "TEAM" }) } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const tenantStatus = { invalidate: jest.fn() } as any;
  const svc = new SubscriptionMutationService(
    prisma,
    cat,
    proration,
    subscription,
    entitlements,
    events,
    tenantStatus,
  );
  return { svc, prisma, tx, events, entitlements };
}

const deltaOf = (events: any, type: string) => {
  const c = events.emit.mock.calls.find((x: any[]) => x[1] === type);
  return c ? c[3]?.amountDelta : undefined;
};
const emitted = (events: any) => events.emit.mock.calls.map((c: any[]) => c[1]);

describe("SubscriptionMutationService.subscribe (MRR = signed change)", () => {
  it("fresh trial: PLAN_CHANGED delta = plan monthly, add-on delta separate; sum = subtotal (no double-count)", async () => {
    const { svc, tx, events, entitlements } = make({ tenantStatus: "TRIAL" });
    await svc.subscribe(
      "t1",
      { planKey: "TEAM", cycle: "MONTHLY", addons: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }] },
      "admin",
    );
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(149); // plan only, NOT 173
    expect(deltaOf(events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24); // 12 × 2
    // ledger sum = 149 + 24 = 173 = subtotal, counted once
    expect(emitted(events)).toEqual(
      expect.arrayContaining([
        BILLING_EVENTS.TRIAL_CONVERTED,
        BILLING_EVENTS.PLAN_CHANGED,
        BILLING_EVENTS.ADDON_ENABLED,
      ]),
    );
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({
      status: "ACTIVE",
      plan: "TEAM",
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("re-subscribe to a LOWER plan emits a NEGATIVE plan delta and disables dropped add-ons", async () => {
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "BUSINESS" },
      priorAddons: [
        {
          id: "a1",
          addonKey: "CUSTOMER_PACK_100",
          sku: "CUSTOMER_PACK_100",
          quantity: 1,
          active: true,
        },
      ],
    });
    await svc.subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" }, "admin");
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(-290); // 59 − 349
    expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-12); // dropped CUSTOMER_PACK_100
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { active: false },
    });
    expect(emitted(events)).not.toContain(BILLING_EVENTS.TRIAL_CONVERTED);
  });

  it("reactivation from READ_ONLY (stale planKey retained) emits a full +base delta, not 0", async () => {
    const { svc, events } = make({
      tenantStatus: "READ_ONLY",
      sub: { planKey: "BUSINESS" }, // planKey survives the cancellation → READ_ONLY
    });
    await svc.subscribe("t1", { planKey: "BUSINESS", cycle: "MONTHLY" }, "admin");
    // Was NOT paying (READ_ONLY) → prior run-rate is 0, so re-entry is the full +349,
    // mirroring the −349 emitted at churn — NOT 349 − 349 = 0.
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(349);
  });

  it("reactivation re-adds add-ons (churn deactivated them) so the ledger nets symmetrically", async () => {
    const { svc, events } = make({
      tenantStatus: "READ_ONLY",
      sub: { planKey: "BUSINESS" },
      priorAddons: [], // churn (applyScheduledCancellations) deactivated the rows
    });
    await svc.subscribe(
      "t1",
      {
        planKey: "BUSINESS",
        cycle: "MONTHLY",
        addons: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
      },
      "admin",
    );
    // Full run-rate re-added: +349 base and +24 add-on (12×2) — matching the −373 at churn.
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(349);
    expect(deltaOf(events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24);
  });

  it("rejects the custom Enterprise plan", async () => {
    await expect(
      make().svc.subscribe("t1", { planKey: "ENTERPRISE", cycle: "MONTHLY" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("writes the legacy TenantPlan enum for renamed keys (GROWTH → TEAM), never the raw key", async () => {
    const { svc, tx } = make({ catalog: catalogV8() });
    await svc.subscribe("t1", { planKey: "GROWTH", cycle: "MONTHLY" });
    // The Prisma TenantPlan enum has no GROWTH/SCALE member — writing the catalog key
    // straight into the shadow column fails enum validation at runtime (500).
    expect(tx.tenantSubscription.upsert.mock.calls[0][0].create).toMatchObject({
      planKey: "GROWTH",
      currentPlan: "TEAM",
    });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ plan: "TEAM" });
  });
});

describe("SubscriptionMutationService.upgrade", () => {
  it("applies instantly (optimistic guard) with MRR delta = new − old", async () => {
    const { svc, tx, events } = make({
      sub: { planKey: "STARTER", cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    await svc.upgrade("t1", "BUSINESS", "admin");
    expect(tx.tenantSubscription.updateMany.mock.calls[0][0].where).toMatchObject({
      planKey: "STARTER",
    });
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(290); // 349 − 59
  });

  it("rejects a concurrent double-upgrade (updateMany matched 0 rows)", async () => {
    const { svc, tx } = make({ sub: { planKey: "STARTER", cycle: "MONTHLY" } });
    tx.tenantSubscription.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.upgrade("t1", "BUSINESS")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a same/lower target", async () => {
    const { svc } = make({ sub: { planKey: "BUSINESS", cycle: "MONTHLY" } });
    await expect(svc.upgrade("t1", "STARTER")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("writes the legacy TenantPlan enum for renamed keys (SCALE → BUSINESS)", async () => {
    const { svc, tx } = make({
      catalog: catalogV8(),
      sub: { planKey: "GROWTH", cycle: "MONTHLY", periodStart: null, periodEnd: null },
    });
    await svc.upgrade("t1", "SCALE");
    expect(tx.tenantSubscription.updateMany.mock.calls[0][0].data).toMatchObject({
      planKey: "SCALE",
      currentPlan: "BUSINESS",
    });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ plan: "BUSINESS" });
  });
});

describe("SubscriptionMutationService downgrade / add-ons", () => {
  it("downgrade schedules without changing entitlements now", async () => {
    const periodEnd = new Date("2026-08-01");
    const { svc, tx, events, entitlements } = make({
      sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodEnd },
    });
    await svc.downgrade("t1", "STARTER", ["u1"], "admin");
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      downgradeToPlanKey: "STARTER",
      downgradeEffectiveAt: periodEnd,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.PLAN_DOWNGRADE_SCHEDULED);
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("enableAddon charges the qty delta only (idempotent re-enable at same qty emits nothing)", async () => {
    // CUSTOMER_PACK_100, not SEAT_EXTRA — SEAT_EXTRA is seat-billing plumbing, never a
    // self-service toggle (see the SELF_SERVICE_ADDON_SKUS tests below).
    const first = make();
    await first.svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "admin");
    expect(deltaOf(first.events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24); // 12 × 2

    const again = make({ existingAddon: { active: true, quantity: 2 } });
    await again.svc.enableAddon("t1", "CUSTOMER_PACK_100", 2);
    expect(emitted(again.events)).not.toContain(BILLING_EVENTS.ADDON_ENABLED); // no change → no MRR event
  });

  it("disableAddon credits the add-on's price (CUSTOMER_PACK_100 × 2)", async () => {
    const { svc, events, tx } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        quantity: 2,
        active: true,
      },
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100");
    expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-24); // 12 × 2
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { active: false },
    });
  });
});

describe("SubscriptionMutationService.enableAddon self-service gate (SELF_SERVICE_ADDON_SKUS)", () => {
  it("403s a self-service enable of an admin-only SKU (MSRP)", async () => {
    const { svc, tx, entitlements } = make();
    await expect(svc.enableAddon("t1", "MSRP", 1, "admin")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("403s a self-service enable of an admin-only SKU (SALES_AGENTS)", async () => {
    const { svc } = make();
    await expect(svc.enableAddon("t1", "SALES_AGENTS", 1, "admin")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows self-service enable of CUSTOMER_PACK_100", async () => {
    const { svc, tx, entitlements } = make();
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "admin");
    expect(tx.tenantAddon.upsert).toHaveBeenCalled();
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("403s a self-service disable of an admin-only SKU, incl. via the legacy addonKey", async () => {
    const { svc, tx } = make({
      addonRow: { id: "a1", addonKey: "tobacco_dealer", sku: null, quantity: 1, active: true },
    });
    // tobacco_dealer bridges to REGULATED_ITEMS — admin-granted, so the tenant cannot
    // switch it off (re-enabling it is a 403, which would be a support-only dead end).
    await expect(svc.disableAddon("t1", "tobacco_dealer")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.tenantAddon.update).not.toHaveBeenCalled();
  });
});

describe("SubscriptionMutationService.subscribe self-service gate (SELF_SERVICE_ADDON_SKUS)", () => {
  it("403s a subscribe that names an admin-only SKU in addons[] — the enableAddon back door", async () => {
    const { svc, tx, entitlements } = make();
    await expect(
      svc.subscribe(
        "t1",
        { planKey: "TEAM", cycle: "MONTHLY", addons: [{ sku: "MSRP" }, { sku: "SALES_AGENTS" }] },
        "admin",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("never revokes an admin-granted add-on the payload omits", async () => {
    const { svc, tx, events } = make({
      tenantStatus: "ACTIVE",
      sub: { planKey: "TEAM" },
      priorAddons: [{ id: "a1", addonKey: "msrp", sku: null, quantity: 1, active: true }],
    });
    await svc.subscribe("t1", { planKey: "TEAM", cycle: "MONTHLY" }, "admin");
    expect(tx.tenantAddon.update).not.toHaveBeenCalled(); // MSRP stays active
    expect(emitted(events)).not.toContain(BILLING_EVENTS.ADDON_DISABLED);
  });
});
