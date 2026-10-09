/**
 * SA-733 D8 / SA-733r [M7] (PR-B1 part B): an upgrade reaches Stripe — Stripe-first, ONE `subscriptions.update`
 * (the base item's new inline `price_data` + a delete for every add-on the new plan includes), compensated by
 * ONE revert when the local write loses — and the add-ons the new plan includes stop billing (B1103).
 *
 * Stripe is mocked at the StripeService boundary: no live call anywhere here. On master `upgrade()` pushed
 * nothing and retired nothing, so every row below is red there.
 */
import { ConflictException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { ProrationService } from "./proration.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";

const DAY = 24 * 60 * 60 * 1000;

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
}

function make(o: Opts = {}) {
  const periodStart = new Date(Date.now() - 15 * DAY);
  const periodEnd = new Date(Date.now() + 15 * DAY);
  const sub = {
    planKey: "GROWTH",
    cycle: "MONTHLY",
    periodStart,
    periodEnd,
    basePriceSnapshot: 249,
    priceOverrideMonthly: null,
    priceOverrideAnnual: null,
    stripeSubId: "sub_1",
    externalPayment: false,
    ...(o.sub ?? {}),
  };
  const addons = o.addons ?? [];
  const tx: any = {
    tenantSubscription: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    tenant: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: "ACTIVE", class: "PRODUCTION", deletedAt: null }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      }),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(addons),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        plan: "PROFESSIONAL",
        status: "ACTIVE",
        deletedAt: null,
        class: "PRODUCTION",
        slug: "acme",
        name: "Acme",
      }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(sub) },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(addons),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const items = o.stripeItems ?? [BASE_ITEM, ADDON_ITEM, KEEP_ITEM];
  const stripe: any = {
    isConfigured: true,
    getSubscription: jest.fn().mockResolvedValue({
      id: "sub_1",
      status: o.stripeStatus ?? "active",
      items: { data: items },
    }),
    updateSubscription: jest.fn().mockResolvedValue({ items: { data: items } }),
    client: { products: { create: jest.fn().mockResolvedValue({ id: "prod_scale" }) } },
  };
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
    stripe,
    { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any,
    {
      prepare: jest.fn().mockResolvedValue({}),
      onPlanChange: jest.fn().mockResolvedValue({}),
      transactionOptions: jest.fn().mockReturnValue(undefined),
      invalidateCaches: jest.fn(),
    } as any,
  );
  return { svc, prisma, tx, stripe, events };
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

  it("a paused/incomplete Stripe subscription is refused (it would stay on the old price), nothing written", async () => {
    const { svc, prisma, stripe } = make({ stripeStatus: "paused" });
    await expect(svc.upgrade("t1", "SCALE", "admin")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
      addons: [row({ id: "ta_comp", isComp: true, stripeItemId: null, priceSnapshot: 0 })],
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
    // The revert re-creates the add-on item under a NEW id, tagged with the one it replaces.
    stripe.updateSubscription.mockResolvedValueOnce({}).mockResolvedValueOnce({
      items: { data: [BASE_ITEM, { id: "si_fc_new", metadata: { restoredFromItem: "si_fc" } }] },
    });

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
    // The row points at the re-created item, so a later disable still removes it from Stripe.
    expect(prisma.tenantAddon.updateMany).toHaveBeenCalledWith({
      where: { id: "ta_fc" },
      data: { stripeItemId: "si_fc_new" },
    });
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
    stripe.updateSubscription
      .mockResolvedValueOnce({})
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

  it("UPGRADE with nothing to retire has an empty list and no add-on note", async () => {
    const { svc } = make({ addons: [] });
    const p = await svc.planChangePreview("t1", "SCALE", "MONTHLY");
    expect(p.retiredAddons).toEqual([]);
    expect(p.warning ?? "").not.toContain("switched off");
  });
});
