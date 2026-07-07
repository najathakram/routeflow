import { BadRequestException } from "@nestjs/common";
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
    ],
  };
}

interface Opts {
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
  const cat = { getPublishedCatalog: jest.fn().mockResolvedValue(catalog()) } as any;
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
      { planKey: "TEAM", cycle: "MONTHLY", addons: [{ sku: "SEAT_EXTRA", quantity: 2 }] },
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
        BILLING_EVENTS.SEAT_ADDED,
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
        { id: "a1", addonKey: "BUYER_PORTAL", sku: "BUYER_PORTAL", quantity: 1, active: true },
      ],
    });
    await svc.subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" }, "admin");
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(-290); // 59 − 349
    expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-49); // dropped BUYER_PORTAL
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { active: false },
    });
    expect(emitted(events)).not.toContain(BILLING_EVENTS.TRIAL_CONVERTED);
  });

  it("rejects the custom Enterprise plan", async () => {
    await expect(
      make().svc.subscribe("t1", { planKey: "ENTERPRISE", cycle: "MONTHLY" }),
    ).rejects.toBeInstanceOf(BadRequestException);
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
    const first = make();
    await first.svc.enableAddon("t1", "SEAT_EXTRA", 2, "admin");
    expect(deltaOf(first.events, BILLING_EVENTS.ADDON_ENABLED)).toBe(24); // 12 × 2

    const again = make({ existingAddon: { active: true, quantity: 2 } });
    await again.svc.enableAddon("t1", "SEAT_EXTRA", 2);
    expect(emitted(again.events)).not.toContain(BILLING_EVENTS.ADDON_ENABLED); // no change → no MRR event
  });

  it("disableAddon credits the CANONICAL price for a legacy addonKey row (tobacco_dealer → REGULATED_ITEMS)", async () => {
    const { svc, events } = make({
      addonRow: { id: "a1", addonKey: "tobacco_dealer", sku: null, quantity: 1, active: true },
    });
    await svc.disableAddon("t1", "tobacco_dealer");
    expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-39); // REGULATED_ITEMS price, NOT -0
  });
});
