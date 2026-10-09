/**
 * SA-733 D8 / SA-733r [M7] (PR-B1 part B): an upgrade reaches Stripe — Stripe-first, ONE `subscriptions.update`
 * (the base item's new inline `price_data` + a delete for every add-on the new plan includes), compensated by
 * ONE revert when the local write loses — and the add-ons the new plan includes stop billing (B1103).
 *
 * Stripe is mocked at the StripeService boundary: no live call anywhere here. On master `upgrade()` pushed
 * nothing and retired nothing, so every row below is red there.
 */
const mockLockQueues = new Map<string, Promise<unknown>>();
const mockWithAdvisoryLock = jest.fn(
  async (opts: { family: string; key: string }, fn: () => Promise<unknown>) => {
    const id = `${opts.family}:${opts.key}`;
    const prior = mockLockQueues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    mockLockQueues.set(
      id,
      prior.then(() => done),
    );
    await prior;
    try {
      return { acquired: true as const, value: await fn() };
    } finally {
      release();
    }
  },
);
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";
import { ScheduledPriceChangeService } from "./scheduled-price-change";
import { PLAN_CHANGE_SUBSCRIPTION_INACTIVE } from "./plan-change-stripe";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { ProrationService } from "./proration.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mockLockQueues.clear();
  mockWithAdvisoryLock.mockClear();
});

const CATALOG = {
  id: "v8",
  definitions: [
    { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, annualPrice: null, isCustom: false },
    { planKey: "SCALE", name: "Scale", monthlyPrice: 499, annualPrice: null, isCustom: false },
    { planKey: "STARTER", name: "Starter", monthlyPrice: 99, annualPrice: null, isCustom: false },
  ],
  addonSkus: [
    // Bundled free at SCALE and above (the catalog's `includedAtPlan`).
    { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25, includedAtPlan: "SCALE" },
    { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12, includedAtPlan: null },
  ],
};

const BASE_ITEM = {
  id: "si_base",
  quantity: 1,
  price: {
    unit_amount: 24900,
    currency: "usd",
    recurring: { interval: "month" },
    product: "prod_growth",
  },
};
const ADDON_ITEM = {
  id: "si_fc",
  quantity: 1,
  price: {
    unit_amount: 2500,
    currency: "usd",
    recurring: { interval: "month" },
    product: "prod_fc",
  },
};
const KEEP_ITEM = {
  id: "si_pack",
  quantity: 2,
  price: {
    unit_amount: 1200,
    currency: "usd",
    recurring: { interval: "month" },
    product: "prod_pack",
  },
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "ta_fc",
  tenantId: "t1",
  addonKey: "FORECASTING",
  sku: "FORECASTING",
  quantity: 1,
  priceSnapshot: 25,
  stripeItemId: "si_fc",
  isComp: false,
  active: true,
  ...over,
});

interface Opts {
  sub?: Record<string, unknown>;
  addons?: any[];
  stripeItems?: any[];
  stripeStatus?: string;
  /** The legacy `Tenant.plan` enum the from-plan resolves through when the row has no planKey. */
  tenantPlan?: string;
  /** Wire the REAL ScheduledPriceChangeService (the pre-renewal downgrade push) into the service. */
  realScheduledPrice?: boolean;
}

/** The rows whose fields all equal the (simple) `where` — enough of Prisma's filter for these specs. */
const matching = (rows: any[], where: any = {}) =>
  rows.filter((r) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "in" in (v as object)
        ? (v as { in: unknown[] }).in.includes(r[k])
        : r[k] === v,
    ),
  );

function make(o: Opts = {}) {
  const periodStart = new Date(Date.now() - 15 * DAY);
  const periodEnd = new Date(Date.now() + 15 * DAY);
  // The committed database. A transaction that throws rolls it back (see $transaction below).
  const db: { sub: any; addons: any[] } = {
    sub: {
      planKey: "GROWTH",
      planVersionId: "v7",
      cycle: "MONTHLY",
      periodStart,
      periodEnd,
      basePriceSnapshot: 249,
      priceOverrideMonthly: null,
      priceOverrideAnnual: null,
      stripeSubId: "sub_1",
      externalPayment: false,
      ...(o.sub ?? {}),
    },
    addons: (o.addons ?? []).map((r) => ({ ...r })),
  };
  const tx: any = {
    tenantSubscription: {
      // The optimistic guard: lands only while the stored plan is still the one the attempt read.
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.planKey !== db.sub.planKey) return { count: 0 };
        Object.assign(db.sub, data);
        return { count: 1 };
      }),
    },
    tenant: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: "ACTIVE", class: "PRODUCTION", deletedAt: null }),
      // emitAddonDelta's paying-set read: judged from the plan the row holds RIGHT NOW.
      findUniqueOrThrow: jest.fn(async () => ({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: db.sub.planKey },
      })),
    },
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any = {}) => matching(db.addons, where)),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(
          db.addons.find((r) => r.id === where.id),
          data,
        );
        return {};
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        plan: o.tenantPlan ?? "PROFESSIONAL",
        status: "ACTIVE",
        deletedAt: null,
        class: "PRODUCTION",
        slug: "acme",
        name: "Acme",
      }),
    },
    tenantSubscription: { findUnique: jest.fn(async () => ({ ...db.sub })) },
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any = {}) => matching(db.addons, where)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const r of matching(db.addons, where)) Object.assign(r, data);
        return { count: 1 };
      }),
    },
    user: { count: jest.fn().mockResolvedValue(0) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) => {
      const saved = JSON.parse(JSON.stringify({ sub: db.sub, addons: db.addons }));
      try {
        return await fn(tx);
      } catch (e) {
        db.sub = { ...saved.sub, periodStart, periodEnd };
        db.addons = saved.addons;
        throw e;
      }
    }),
  };
  const stripe = fakeStripeSubscription(
    o.stripeItems ?? [BASE_ITEM, ADDON_ITEM, KEEP_ITEM],
    o.stripeStatus ?? "active",
  );
  const events: any = { emit: jest.fn().mockResolvedValue({}) };
  const entitlements = { invalidate: jest.fn() };
  const notify = { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) };
  const real = new ProrationService({} as any, {} as any);
  const catalogSvc = {
    getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG),
    getVersionForTenant: jest.fn().mockResolvedValue(CATALOG),
    getPublishedVersion: jest.fn().mockResolvedValue(null),
  } as any;
  const svc = new SubscriptionMutationService(
    prisma,
    catalogSvc,
    {
      proratedDiff: (...a: Parameters<ProrationService["proratedDiff"]>) => real.proratedDiff(...a),
    } as any,
    { getSubscription: jest.fn().mockResolvedValue({}) } as any,
    entitlements as any,
    events,
    { invalidate: jest.fn() } as any,
    stripe as any,
    notify as any,
    {
      prepare: jest.fn().mockResolvedValue({}),
      onPlanChange: jest.fn().mockResolvedValue({}),
      transactionOptions: jest.fn().mockReturnValue(undefined),
      invalidateCaches: jest.fn(),
    } as any,
    o.realScheduledPrice
      ? (new ScheduledPriceChangeService(prisma, stripe as any, catalogSvc) as any)
      : undefined,
  );
  return { svc, prisma, tx, stripe, events, db, entitlements, notify };
}

const typesOf = (events: any, type: string) =>
  events.emit.mock.calls.filter((c: any[]) => c[1] === type);

describe("upgrade(): the plan change reaches Stripe, Stripe-first (B1104)", () => {
  it("one subscriptions.update on the base item with the new inline price_data and create_prorations", async () => {
    const { svc, stripe } = make();
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const [subId, params, opts] = stripe.updateSubscription.mock.calls[0];
    expect(subId).toBe("sub_1");
    expect(params.proration_behavior).toBe("create_prorations");
    expect(params.items[0]).toEqual({
      id: "si_base",
      price_data: {
        currency: "usd",
        unit_amount: 49900,
        recurring: { interval: "month" },
        product: "prod_scale",
      },
    });
    // The idempotency key names (tenant, plan-change, target version); a fresh nonce per attempt.
    expect(opts.idempotencyKey).toMatch(/^t1:plan-change:v8:[0-9a-f-]{36}$/);
  });

  it("a tenant price override WINS: the override is pushed, not the plan price", async () => {
    const { svc, stripe } = make({ sub: { priceOverrideMonthly: 300, basePriceSnapshot: 300 } });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription.mock.calls[0][1].items[0].price_data.unit_amount).toBe(30000);
  });

  it("Stripe first: the local write has not run when Stripe is called, and a Stripe failure writes nothing", async () => {
    const { svc, prisma, stripe, events } = make();
    stripe.updateSubscription.mockRejectedValueOnce(new Error("card_declined internal detail"));

    const err = await svc.upgrade("t1", "SCALE", "admin").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).not.toContain("internal detail");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("books MRR once: one PLAN_CHANGED = new base − old snapshot, no second price delta", async () => {
    const { svc, events } = make();
    await svc.upgrade("t1", "SCALE", "admin");

    const planChanged = typesOf(events, BILLING_EVENTS.PLAN_CHANGED);
    expect(planChanged).toHaveLength(1);
    expect(planChanged[0][3].amountDelta).toBe(250); // 499 − 249
    // The attempt's idempotency key rides on the ledger event (SA-733r2 N4: recorded with the attempt).
    expect(planChanged[0][2].stripeIdempotencyKey).toMatch(/:plan-change:v8:/);
  });

  it("a tenant with no Stripe subscription pushes nothing (manual-pay / pilot)", async () => {
    const { svc, stripe } = make({ sub: { stripeSubId: null } });
    await svc.upgrade("t1", "SCALE", "admin");
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("a cancelled Stripe subscription has nothing to bill: no push, the local upgrade still lands", async () => {
    const { svc, stripe, tx } = make({ stripeStatus: "canceled" });
    await svc.upgrade("t1", "SCALE", "admin");
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.updateMany).toHaveBeenCalled();
  });

  it("a paused/incomplete Stripe subscription is refused (it would stay on the old price), nothing written, and the copy never says 'try again'", async () => {
    const { svc, prisma, stripe } = make({ stripeStatus: "paused" });
    const err = await svc.upgrade("t1", "SCALE", "admin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe(PLAN_CHANGE_SUBSCRIPTION_INACTIVE);
    expect((err as Error).message).not.toMatch(/try again/i);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("S5: a double-click burst that times out on the short wait is a coded retryable 409 with tenant-safe copy, and nothing ran", async () => {
    const { LockTimeoutError } = jest.requireMock("../common/db-locks");
    mockWithAdvisoryLock.mockRejectedValueOnce(new LockTimeoutError("tenant-price", "t1", 2500));
    const { svc, stripe, prisma } = make();

    const err: any = await svc.upgrade("t1", "SCALE", "admin").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe("CONCURRENT_UPDATE");
    expect(err.getResponse().message).toMatch(/plan is already being changed/i);
    expect(err.getResponse().message).not.toMatch(/tenant|stripe|lock/i);
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("runs under the tenant-price advisory lock, the family the price override takes, with the SHORT self-serve wait", async () => {
    const { svc } = make();
    await svc.upgrade("t1", "SCALE", "admin");
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      { family: "tenant-price", key: "t1", mode: "wait", waitMs: 2_500 },
      expect.any(Function),
    );
  });
});

describe("upgrade(): proration follows the subscription's state, and an unchanged price is not re-sent", () => {
  it("S1: a past_due subscription is pushed with proration none (the same rule as the price override), and the revert reuses it", async () => {
    const { svc, stripe, tx } = make({ stripeStatus: "past_due" });
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);

    expect(stripe.updateSubscription.mock.calls[0][1].proration_behavior).toBe("none");
    expect(stripe.updateSubscription.mock.calls[1][1].proration_behavior).toBe("none"); // the revert
  });

  it("R2: an upgrade on a TRIALING Stripe subscription sends proration none and claims NO charge - not in the response, the ledger event or the email", async () => {
    const { svc, stripe, events, notify } = make({ stripeStatus: "trialing" });
    const res = await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription.mock.calls[0][1].proration_behavior).toBe("none");
    expect(res.proratedNow).toBe(0); // the local estimate would have been > 0 on an active sub
    expect(typesOf(events, BILLING_EVENTS.PLAN_CHANGED)[0][2].prorated).toBe(0);
    expect(notify.notifyUpgradeConfirmed.mock.calls[0][3]).toBe(0);
  });

  it("R2: the same upgrade on an ACTIVE subscription still quotes and sends create_prorations (the control)", async () => {
    const { svc, stripe, notify } = make();
    const res = await svc.upgrade("t1", "SCALE", "admin");
    expect(stripe.updateSubscription.mock.calls[0][1].proration_behavior).toBe("create_prorations");
    expect(res.proratedNow).toBeGreaterThan(0);
    expect(notify.notifyUpgradeConfirmed.mock.calls[0][3]).toBe(res.proratedNow);
  });

  it("R2: the choose-plan preview quotes 0 for a trialing (or past_due) Stripe subscription, and a positive estimate for an active one", async () => {
    for (const [status, positive] of [
      ["trialing", false],
      ["past_due", false],
      ["active", true],
    ] as const) {
      const { svc } = make({ stripeStatus: status });
      const p = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
      expect(p.action).toBe("UPGRADE");
      expect(p.proratedNow! > 0).toBe(positive);
    }
  });

  it("R2: an unreadable Stripe leaves the local estimate in the preview (best effort, never an error)", async () => {
    const { svc, stripe } = make();
    stripe.getSubscription.mockRejectedValue(new Error("stripe down"));
    const p = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
    expect(p.proratedNow).toBeGreaterThan(0);
  });

  it("S2: a custom-fee tenant whose resolved amount equals the item's amount sends NO Stripe update at all (no net-zero proration noise)", async () => {
    // The fee 249 is already what the base item bills (24900); the upgrade moves the plan, not the price.
    const { svc, stripe, tx } = make({
      sub: { priceOverrideMonthly: 249, basePriceSnapshot: 249 },
    });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(stripe.client.products.create).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.updateMany).toHaveBeenCalled(); // the local plan change still lands
  });

  it("S2: unchanged price WITH an add-on to delete: the base item is left out of the update, the delete rides alone", async () => {
    const { svc, stripe } = make({
      sub: { priceOverrideMonthly: 249, basePriceSnapshot: 249 },
      addons: [row()],
    });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const params = stripe.updateSubscription.mock.calls[0][1];
    expect(params.items).toEqual([{ id: "si_fc", deleted: true }]);
    expect(stripe.client.products.create).not.toHaveBeenCalled(); // no new product/price minted
    expect(stripe.amountOf("si_base")).toBe(24900);
  });

  it("S2: ... and its revert re-creates the add-on item without touching the untouched base item", async () => {
    const { svc, stripe, tx } = make({
      sub: { priceOverrideMonthly: 249, basePriceSnapshot: 249 },
      addons: [row()],
    });
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);

    const revert = stripe.updateSubscription.mock.calls[1][1];
    expect(revert.items).toHaveLength(1);
    expect(revert.items[0]).toMatchObject({ metadata: { restoredFromItem: "si_fc" } });
    expect(revert.items[0].id).toBeUndefined();
  });
});

describe("upgrade(): a pre-renewal downgrade push is undone FIRST (R1 Option B)", () => {
  const pushedLow = (cents: number) => ({
    ...BASE_ITEM,
    price: { ...BASE_ITEM.price, unit_amount: cents, product: "prod_low" },
  });
  // Built per TEST (a function), never at describe/collection time: a clock fuse started at collection
  // can expire before the test runs on a slow host (no-collection-time-clock-fuse.spec.ts).
  const scheduled = () => ({
    downgradeToPlanKey: "STARTER",
    downgradeEffectiveAt: new Date(Date.now() + 2 * DAY),
  });

  it("an early push left Stripe on the lowered price (9900): the upgrade restores the CURRENT price (24900, none) BEFORE it prorates, so the proration is (new - current), not (new - lowered)", async () => {
    const { svc, stripe, db } = make({
      realScheduledPrice: true,
      sub: scheduled(),
      stripeItems: [pushedLow(9900), ADDON_ITEM, KEEP_ITEM],
    });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(2);
    const [, restore] = stripe.updateSubscription.mock.calls[0];
    const [, upgrade] = stripe.updateSubscription.mock.calls[1];
    expect(restore.items[0].price_data.unit_amount).toBe(24900);
    expect(restore.proration_behavior).toBe("none"); // the restore itself charges nothing
    expect(upgrade.items[0].price_data.unit_amount).toBe(49900);
    expect(upgrade.proration_behavior).toBe("create_prorations");
    // The upgrade push read the RESTORED item, so Stripe prorates 24900 -> 49900, not 9900 -> 49900.
    expect(stripe.getSubscription.mock.results.length).toBeGreaterThanOrEqual(2);
    expect(db.sub.planKey).toBe("SCALE");
    expect(db.sub.downgradeToPlanKey).toBeNull(); // the schedule is disarmed by the upgrade
    expect(stripe.amountOf("si_base")).toBe(49900);
  });

  it("no early push (Stripe still on the current price) -> no restore call, only the upgrade push", async () => {
    const { svc, stripe } = make({ realScheduledPrice: true, sub: scheduled() });
    await svc.upgrade("t1", "SCALE", "admin");
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it("a failed restore stops the upgrade BEFORE it pushes or writes anything (fail closed: never prorate from the lowered price)", async () => {
    const { svc, stripe, db, prisma } = make({
      realScheduledPrice: true,
      sub: scheduled(),
      stripeItems: [pushedLow(9900), ADDON_ITEM, KEEP_ITEM],
    });
    stripe.updateSubscription.mockRejectedValueOnce(new Error("stripe down"));
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeDefined();
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.sub.planKey).toBe("GROWTH");
  });

  it("L1: a custom-fee upgrade whose price does not change still guards add-on items it did not settle (a row enabled after Stripe was read)", async () => {
    const { svc, stripe, tx } = make({
      sub: { priceOverrideMonthly: 249, basePriceSnapshot: 249 },
    });
    tx.tenantAddon.findMany.mockResolvedValue([row({ id: "ta_new", stripeItemId: "si_new" })]);
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);
    expect(stripe.updateSubscription).not.toHaveBeenCalled(); // nothing was pushed, nothing to revert
  });
});

describe("upgrade(): the add-ons the new plan includes stop billing (B1103)", () => {
  it("GROWTH + an included add-on item -> upgrade(SCALE): item deleted in the SAME update with create_prorations, row inactive, MRR −price once", async () => {
    const { svc, stripe, tx, events } = make({ addons: [row()] });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const params = stripe.updateSubscription.mock.calls[0][1];
    expect(params.proration_behavior).toBe("create_prorations");
    expect(params.items).toContainEqual({ id: "si_fc", deleted: true });
    // The add-on the plan does NOT include is untouched.
    expect(params.items.map((i: any) => i.id)).not.toContain("si_pack");

    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "ta_fc" },
      data: { active: false, stripeItemId: null },
    });
    const addonDeltas = typesOf(events, BILLING_EVENTS.ADDON_DISABLED);
    expect(addonDeltas).toHaveLength(1);
    expect(addonDeltas[0][3].amountDelta).toBe(-25);
    expect(addonDeltas[0][2].sku).toBe("FORECASTING");
  });

  it("a COMP add-on is deactivated with NO Stripe item delete and NO ledger delta", async () => {
    const { svc, stripe, tx, events } = make({
      // A STALE snapshot > 0 on purpose: only the isComp skip keeps the ledger clean.
      addons: [row({ id: "ta_comp", isComp: true, stripeItemId: null, priceSnapshot: 25 })],
    });
    await svc.upgrade("t1", "SCALE", "admin");

    const params = stripe.updateSubscription.mock.calls[0][1];
    expect(params.items.some((i: any) => i.deleted)).toBe(false);
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "ta_comp" },
      data: { active: false, stripeItemId: null },
    });
    expect(typesOf(events, BILLING_EVENTS.ADDON_DISABLED)).toHaveLength(0);
  });

  it("a manual-pay tenant gets a STOP notice for the retired, priced add-on (and no Stripe call)", async () => {
    const { svc, stripe, tx } = make({
      sub: { stripeSubId: null, externalPayment: true },
      addons: [row({ stripeItemId: null })],
    });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    const notice = tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    expect(notice).toHaveLength(1);
    expect(notice[0].action).toBe(AdminAuditAction.ADDON_MANUAL_INVOICE_STOP);
    expect(notice[0].meta).toMatchObject({ sku: "FORECASTING", kind: "stop", monthlyPrice: 25 });
  });

  it("a Stripe-billed tenant gets NO manual STOP notice (its item is deleted in Stripe instead)", async () => {
    const { svc, tx } = make({ addons: [row()] });
    await svc.upgrade("t1", "SCALE", "admin");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a row already switched off by a concurrent disable books nothing twice", async () => {
    // The pre-tx read still sees it active; the tx re-read (under the row lock) finds it gone.
    const { svc, tx, events } = make({ addons: [row()] });
    tx.tenantAddon.findMany.mockResolvedValue([]);
    await svc.upgrade("t1", "SCALE", "admin");
    expect(tx.tenantAddon.update).not.toHaveBeenCalled();
    expect(typesOf(events, BILLING_EVENTS.ADDON_DISABLED)).toHaveLength(0);
  });

  it("an add-on item Stripe no longer has is already settled: it is not in the delete list, the row still retires", async () => {
    const { svc, stripe, tx } = make({ addons: [row()], stripeItems: [BASE_ITEM, KEEP_ITEM] });
    await svc.upgrade("t1", "SCALE", "admin");
    expect(stripe.updateSubscription.mock.calls[0][1].items.some((i: any) => i.deleted)).toBe(
      false,
    );
    expect(tx.tenantAddon.update).toHaveBeenCalled();
  });

  it("an add-on enabled after Stripe was read (an item the push did not settle) aborts the change and puts Stripe back", async () => {
    const { svc, stripe, tx } = make({ addons: [] });
    tx.tenantAddon.findMany.mockResolvedValue([row({ id: "ta_new", stripeItemId: "si_new" })]);

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(2); // push + revert
  });
});

describe("upgrade(): a failed local write puts Stripe back (SA-733r M7)", () => {
  it("local CAS 409 after Stripe OK -> ONE revert update restoring the prior base price and re-creating the deleted add-on item", async () => {
    const { svc, stripe, tx, prisma } = make({ addons: [row()] });
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(2);
    const [, forward, fOpts] = stripe.updateSubscription.mock.calls[0];
    const [subId, revert, rOpts] = stripe.updateSubscription.mock.calls[1];
    expect(subId).toBe("sub_1");
    expect(rOpts.idempotencyKey).toBe(`${fOpts.idempotencyKey}:revert`);
    expect(revert.proration_behavior).toBe(forward.proration_behavior);
    expect(revert.items[0]).toEqual({
      id: "si_base",
      price_data: {
        currency: "usd",
        unit_amount: 24900,
        recurring: { interval: "month" },
        product: "prod_growth",
      },
    });
    expect(revert.items[1]).toMatchObject({
      price_data: { unit_amount: 2500, product: "prod_fc", recurring: { interval: "month" } },
      quantity: 1,
      metadata: { restoredFromItem: "si_fc" },
    });
    // The row points at the re-created item (a NEW id Stripe made), so a later disable still removes it.
    expect(prisma.tenantAddon.updateMany).toHaveBeenCalledWith({
      where: { id: "ta_fc", tenantId: "t1" },
      data: { stripeItemId: "si_new_1" },
    });
    // Stripe is back where it started: base on the old price, the add-on item present again.
    expect(stripe.amountOf("si_base")).toBe(24900);
    expect(stripe.state.items.map((i: any) => i.id)).toEqual(["si_base", "si_pack", "si_new_1"]);
  });

  it("a retry after a revert uses a NEW idempotency key (Stripe really applies it, never replays the cached success)", async () => {
    const { svc, stripe, tx } = make();
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    await svc.upgrade("t1", "SCALE", "admin").catch(() => undefined);
    await svc.upgrade("t1", "SCALE", "admin");

    const keys = stripe.updateSubscription.mock.calls.map((c: any[]) => c[2].idempotencyKey);
    expect(keys).toHaveLength(3); // push, revert, push again
    expect(keys[1]).toBe(`${keys[0]}:revert`);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[2]).toMatch(/^t1:plan-change:v8:/);
  });

  it("when the revert ALSO fails: a distinct 502 PLAN_CHANGE_STRIPE_AHEAD names both prices, an audit row is written, and an ERROR alert names the tenant and both states", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe, tx, prisma } = make();
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    // The push goes through the fake; only the REVERT is refused.
    const applyPush = stripe.updateSubscription.getMockImplementation()!;
    stripe.updateSubscription
      .mockImplementationOnce(applyPush)
      .mockRejectedValueOnce(new Error("stripe down"));

    const err: any = await svc.upgrade("t1", "SCALE", "admin").catch((e: unknown) => e);

    // NOT the ordinary original 409: Stripe now bills a price the database does not hold.
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.getResponse().code).toBe("PLAN_CHANGE_STRIPE_AHEAD");
    expect(err.getResponse().message).toContain("Stripe now bills $499");
    expect(err.getResponse().message).toContain("the database still says $249");
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ tenantId: "t1", userId: "admin" });
    expect(audit.meta).toMatchObject({
      kind: "plan_change_stripe_ahead",
      targetPlanKey: "SCALE",
      pushedAmountCents: 49900,
      priorAmountCents: 24900,
    });

    const alert = error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("needs_reconcile"));
    expect(alert).toBeDefined();
    const body = JSON.parse(alert!.slice(alert!.indexOf("{")));
    expect(body).toMatchObject({
      event: "billing.plan_change.needs_reconcile",
      severity: "ERROR",
      tenantId: "t1",
      stripeSubId: "sub_1",
      localState: { fromPlanKey: "GROWTH", toPlanKey: "SCALE" },
      error: "stripe down",
    });
    expect(body.stripeState).toMatchObject({ pushedPlanKey: "SCALE", pushedAmountCents: 49900 });
    error.mockRestore();
  });

  it("a local failure that is not a CAS (any throw) reverts too", async () => {
    const { svc, stripe, events } = make();
    events.emit.mockRejectedValueOnce(new Error("ledger write failed"));
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toThrow("ledger write failed");
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(2);
  });

  it("no revert when nothing was pushed (a manual-pay tenant's CAS loss is just the 409)", async () => {
    const { svc, stripe, tx } = make({ sub: { stripeSubId: null } });
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });
});

describe("upgrade(): the compensating revert never clobbers a newer price (SA-733r M7, Opus review)", () => {
  it("two concurrent upgrades serialise: the second sees the first's result, pushes nothing, reverts nothing; Stripe == the database", async () => {
    const { svc, stripe, db } = make();
    const results = await Promise.allSettled([
      svc.upgrade("t1", "SCALE", "admin"),
      svc.upgrade("t1", "SCALE", "admin"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(BadRequestException); // "not an upgrade" — read INSIDE the lock
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1); // one push, NO revert
    expect(db.sub.planKey).toBe("SCALE");
    expect(stripe.amountOf("si_base")).toBe(49900); // Stripe bills what the database says
  });

  it("an ambiguous commit failure (the write landed, the reply did not) is a SUCCESS: no revert, and the upgrade's side effects still run", async () => {
    const { svc, stripe, tx, db, prisma, entitlements, notify } = make();
    // The transaction COMMITS (no rollback) and then the client is told it failed.
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      await fn(tx);
      throw new Error("connection lost after commit");
    });

    const res = await svc.upgrade("t1", "SCALE", "admin");

    expect(res.proratedNow).toBeGreaterThan(0); // resolved like any upgrade
    expect(db.sub.planKey).toBe("SCALE");
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1); // the push only - never a revert
    expect(stripe.amountOf("si_base")).toBe(49900); // Stripe == the database
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1"); // caches invalidated
    expect(notify.notifyUpgradeConfirmed).toHaveBeenCalledTimes(1); // the confirmation still goes out
  });

  it("Stripe unreadable when the revert would verify it: nothing is overwritten blind, and it is the same 502 STRIPE_AHEAD", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe, tx, prisma } = make();
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    const read = stripe.getSubscription.getMockImplementation()!;
    // push read OK, the revert-time verification read fails
    stripe.getSubscription.mockImplementationOnce(read).mockRejectedValueOnce(new Error("timeout"));

    const err: any = await svc.upgrade("t1", "SCALE", "admin").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadGatewayException);
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1); // no blind revert
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("a price Stripe holds that this push did not write (an override landed meanwhile) is NOT overwritten by the revert", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe, tx } = make();
    // While this attempt's local write is in flight, another writer re-prices the base item in Stripe;
    // then this attempt's own CAS loses.
    tx.tenantSubscription.updateMany.mockImplementationOnce(async () => {
      const base = stripe.state.items.find((i: any) => i.id === "si_base")!;
      base.price = { ...base.price, unit_amount: 30000, product: "prod_override" };
      return { count: 0 };
    });

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1); // no revert
    expect(stripe.amountOf("si_base")).toBe(30000); // the newer price stands
    const alert = error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("needs_reconcile"));
    expect(alert).toContain("no longer carries the price this push wrote");
    error.mockRestore();
  });

  it("a deleted add-on item is re-created only for a row that is STILL active (a concurrent disable stays disabled)", async () => {
    const { svc, stripe, tx, prisma } = make({ addons: [row()] });
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    const read = prisma.tenantAddon.findMany.getMockImplementation()!;
    // The revert-time re-read (by id) finds the row switched off meanwhile.
    prisma.tenantAddon.findMany.mockImplementation(async (a: any) => (a?.where?.id ? [] : read(a)));

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(2);
    const revert = stripe.updateSubscription.mock.calls[1][1];
    expect(revert.items).toHaveLength(1); // the base item only — no re-created add-on
    expect(stripe.state.items.map((i: any) => i.id)).not.toContain("si_fc");
  });
});

describe("upgrade(): MRR ledger and flat-SKU guards", () => {
  it("S2: a planKey-NULL (manual-activation) row books NOTHING for the retired add-on — its +price never reached the ledger", async () => {
    const { svc, events, db } = make({
      tenantPlan: "STARTER",
      sub: { planKey: null, basePriceSnapshot: null, stripeSubId: null },
      addons: [row({ stripeItemId: null })],
    });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(db.addons[0].active).toBe(false);
    expect(typesOf(events, BILLING_EVENTS.ADDON_DISABLED)).toHaveLength(0);
    expect(typesOf(events, BILLING_EVENTS.PLAN_CHANGED)[0][3].amountDelta).toBe(499);
  });

  it("a stackable row holding more than one unit is never retired wholesale (flat SKUs only)", async () => {
    const { svc, stripe, tx, events } = make({ addons: [row({ quantity: 2 })] });
    await svc.upgrade("t1", "SCALE", "admin");

    expect(stripe.updateSubscription.mock.calls[0][1].items.some((i: any) => i.deleted)).toBe(
      false,
    );
    expect(tx.tenantAddon.update).not.toHaveBeenCalled();
    expect(typesOf(events, BILLING_EVENTS.ADDON_DISABLED)).toHaveLength(0);
  });
});

describe("planChangePreview(): lists the add-ons an upgrade retires (B1103)", () => {
  it("UPGRADE names each included add-on, in the structured list and in the warning", async () => {
    const { svc } = make({
      addons: [
        row(),
        row({
          id: "ta_pack",
          addonKey: "CUSTOMER_PACK_100",
          sku: "CUSTOMER_PACK_100",
          stripeItemId: "si_pack",
        }),
      ],
    });
    const p = await svc.planChangePreview("t1", "SCALE", "MONTHLY");

    expect(p.action).toBe("UPGRADE");
    expect(p.retiredAddons).toEqual([{ sku: "FORECASTING", name: "Forecasting" }]);
    expect(p.warning).toContain("Forecasting");
    expect(p.warning).toContain("Scale");
  });

  it("a row holding more than one unit is not listed (it would not be retired)", async () => {
    const { svc } = make({ addons: [row({ quantity: 3 })] });
    const p = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
    expect(p.retiredAddons).toEqual([]);
  });

  it("UPGRADE with nothing to retire has an empty list and no add-on note", async () => {
    const { svc } = make({ addons: [] });
    const p = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
    expect(p.retiredAddons).toEqual([]);
    expect(p.warning ?? "").not.toContain("switched off");
  });
});
