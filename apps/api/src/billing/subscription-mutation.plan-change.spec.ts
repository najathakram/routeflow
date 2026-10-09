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
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";
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
  const real = new ProrationService({} as any, {} as any);
  const svc = new SubscriptionMutationService(
    prisma,
    {
      getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG),
      getVersionForTenant: jest.fn().mockResolvedValue(CATALOG),
    } as any,
    {
      proratedDiff: (...a: Parameters<ProrationService["proratedDiff"]>) => real.proratedDiff(...a),
    } as any,
    { getSubscription: jest.fn().mockResolvedValue({}) } as any,
    { invalidate: jest.fn() } as any,
    events,
    { invalidate: jest.fn() } as any,
    stripe as any,
    { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any,
    {
      prepare: jest.fn().mockResolvedValue({}),
      onPlanChange: jest.fn().mockResolvedValue({}),
      transactionOptions: jest.fn().mockReturnValue(undefined),
      invalidateCaches: jest.fn(),
    } as any,
  );
  return { svc, prisma, tx, stripe, events, db };
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

  it("runs under the tenant-price advisory lock, the family the price override takes (wait mode, keyed on the tenant)", async () => {
    const { svc } = make();
    await svc.upgrade("t1", "SCALE", "admin");
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      { family: "tenant-price", key: "t1", mode: "wait" },
      expect.any(Function),
    );
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

  it("when the revert ALSO fails: the original error is rethrown and an ERROR-level needs-reconcile alert names the tenant and both states", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe, tx } = make();
    tx.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    // The push goes through the fake; only the REVERT is refused.
    const applyPush = stripe.updateSubscription.getMockImplementation()!;
    stripe.updateSubscription
      .mockImplementationOnce(applyPush)
      .mockRejectedValueOnce(new Error("stripe down"));

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(ConflictException);

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

  it("an ambiguous commit failure (the write landed, the reply did not) does NOT revert: local already shows the target, so it alerts", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe, tx, db, prisma } = make();
    // The transaction COMMITS (no rollback) and then the client is told it failed.
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      await fn(tx);
      throw new Error("connection lost after commit");
    });

    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toThrow("connection lost");

    expect(db.sub.planKey).toBe("SCALE");
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1); // the push only — never a revert
    expect(stripe.amountOf("si_base")).toBe(49900); // Stripe == the database
    const alert = error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("needs_reconcile"));
    expect(alert).toContain("already shows the target plan");
    error.mockRestore();
  });

  it("a price Stripe holds that this push did not write (an override landed meanwhile) is NOT overwritten by the revert", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe, tx } = make();
    // While this attempt's local write is in flight, another writer re-prices the base item in Stripe;
    // then this attempt's own CAS loses.
    tx.tenantSubscription.updateMany.mockImplementationOnce(async () => {
      const base = stripe.state.items.find((i: any) => i.id === "si_base");
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
