/**
 * SA-733r [M7]: the Stripe half of every price-moving plan write, tested at the StripeService boundary (a
 * mock — no live Stripe). Covers the shapes `upgrade()` / `updatePlan` / a schedule-time downgrade would share:
 * `create_prorations` for an upgrade, `none` for a downgrade, the override beating the plan price, fail-closed
 * before any write, and the needs-reconcile seam.
 */
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import {
  markNeedsReconcile,
  PLAN_CHANGE_SUBSCRIPTION_INACTIVE,
  pushPlanChange,
  revertPlanChange,
} from "./plan-change-stripe";
import { planChangeArgs, runStripeFirstPlanChange } from "./plan-change-flow";

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

const BASE = {
  id: "si_base",
  price: {
    unit_amount: 34900,
    currency: "usd",
    recurring: { interval: "month" },
    product: "prod_growth",
  },
};

function stripeWith(sub: any = { status: "active", items: { data: [BASE] } }) {
  return {
    isConfigured: true,
    getSubscription: jest.fn().mockResolvedValue(sub),
    updateSubscription: jest.fn().mockResolvedValue({}),
    client: { products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) } },
  };
}

const args = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  stripeSubId: "sub_1",
  targetPlanKey: "GROWTH",
  targetPlanVersionId: "v8",
  planName: "Growth",
  price: { monthly: 249, annual: 2490 },
  proration: "none" as const,
  knownAddonItemIds: new Set<string>(),
  deleteItems: [],
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("pushPlanChange", () => {
  it("a scheduled downgrade pushes the downgraded price with proration_behavior none", async () => {
    const stripe = stripeWith();
    const push = await pushPlanChange({ stripe, logger }, args());

    expect(push.pushed).toBe(true);
    const [, params] = stripe.updateSubscription.mock.calls[0];
    expect(params.proration_behavior).toBe("none");
    expect(params.items).toEqual([
      {
        id: "si_base",
        price_data: {
          currency: "usd",
          unit_amount: 24900,
          recurring: { interval: "month" },
          product: "prod_new",
        },
      },
    ]);
  });

  it("amounts are whole cents via toCents: 19.99 -> 1999, 0.1 + 0.2 -> 30, 1.005 -> 101", async () => {
    for (const [dollars, cents] of [
      [19.99, 1999],
      [0.1 + 0.2, 30],
      [1.005, 101],
    ] as const) {
      const stripe = stripeWith();
      await pushPlanChange({ stripe, logger }, args({ price: { monthly: dollars, annual: 0 } }));
      expect(stripe.updateSubscription.mock.calls[0][1].items[0].price_data.unit_amount).toBe(
        cents,
      );
    }
  });

  it("an annual item is priced with the ANNUAL amount", async () => {
    const annual = {
      ...BASE,
      price: { ...BASE.price, recurring: { interval: "year" }, unit_amount: 249000 },
    };
    const stripe = stripeWith({ status: "active", items: { data: [annual] } });
    await pushPlanChange({ stripe, logger }, args({ price: { monthly: 100, annual: 1000 } }));
    const pd = stripe.updateSubscription.mock.calls[0][1].items[0].price_data;
    expect(pd).toMatchObject({ unit_amount: 100000, recurring: { interval: "year" } });
  });

  it("skips (no write) without a subscription id, with Stripe off, and for a cancelled subscription", async () => {
    const a = stripeWith();
    expect((await pushPlanChange({ stripe: a, logger }, args({ stripeSubId: null }))).pushed).toBe(
      false,
    );
    const off = { ...stripeWith(), isConfigured: false };
    expect((await pushPlanChange({ stripe: off, logger }, args())).pushed).toBe(false);
    const dead = stripeWith({ status: "canceled", items: { data: [BASE] } });
    expect((await pushPlanChange({ stripe: dead, logger }, args())).pushed).toBe(false);
    for (const s of [a, off, dead]) expect(s.updateSubscription).not.toHaveBeenCalled();
  });

  it("fails closed BEFORE any write: unreadable Stripe, a base price it cannot restore, no resolvable price", async () => {
    const unreadable = stripeWith();
    unreadable.getSubscription.mockRejectedValue(new Error("boom"));
    await expect(pushPlanChange({ stripe: unreadable, logger }, args())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const noPrice = stripeWith({
      status: "active",
      items: { data: [{ id: "si_base", price: { currency: "usd" } }] },
    });
    await expect(pushPlanChange({ stripe: noPrice, logger }, args())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const free = stripeWith();
    await expect(
      pushPlanChange({ stripe: free, logger }, args({ price: null })),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const s of [unreadable, noPrice, free])
      expect(s.updateSubscription).not.toHaveBeenCalled();
  });

  it("an add-on item whose price Stripe cannot give back is refused (it could not be restored)", async () => {
    const addon = { id: "si_a", quantity: 1, price: { currency: "usd" } };
    const stripe = stripeWith({ status: "active", items: { data: [BASE, addon] } });
    await expect(
      pushPlanChange(
        { stripe, logger },
        args({
          knownAddonItemIds: new Set(["si_a"]),
          deleteItems: [{ itemId: "si_a", rowId: "r1" }],
        }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("revert replays the prior base price with the SAME proration and the :revert key", async () => {
    const stripe = stripeWith();
    const push = await pushPlanChange({ stripe, logger }, args({ proration: "create_prorations" }));
    await revertPlanChange({ stripe, logger }, push);

    const [, params, opts] = stripe.updateSubscription.mock.calls[1];
    expect(params.proration_behavior).toBe("create_prorations");
    expect(params.items[0]).toMatchObject({ id: "si_base", price_data: { unit_amount: 34900 } });
    expect(opts.idempotencyKey).toBe(`${push.key}:revert`);
  });
});

describe("pushPlanChange — Opus review folds", () => {
  it("S4: the structured push line (tenant, key, target plan/version, base price) is logged BEFORE the Stripe write", async () => {
    const stripe = stripeWith();
    const push = await pushPlanChange({ stripe, logger }, args({ proration: "create_prorations" }));

    const line = logger.log.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith("billing.plan_change.push"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf("{")))).toMatchObject({
      tenantId: "t1",
      idempotencyKey: push.key,
      targetPlanKey: "GROWTH",
      targetPlanVersionId: "v8",
      basePriceCents: 24900,
    });
    const logOrder = logger.log.mock.invocationCallOrder[0];
    expect(logOrder).toBeLessThan(stripe.updateSubscription.mock.invocationCallOrder[0]);
  });

  it("a checkout-made add-on item (SKU marker on its product, no row pointer yet) is never taken for the base-plan item", async () => {
    const marked = {
      id: "si_checkout_addon",
      quantity: 1,
      price: {
        unit_amount: 2500,
        currency: "usd",
        recurring: { interval: "month" },
        product: { id: "prod_fc", metadata: { addonSku: "FORECASTING" } },
      },
    };
    // Listed FIRST: Stripe does not order items base-first.
    const stripe = stripeWith({ status: "active", items: { data: [marked, BASE] } });
    await pushPlanChange({ stripe, logger }, args());
    expect(stripe.updateSubscription.mock.calls[0][1].items[0].id).toBe("si_base");
  });

  it("a paused subscription is refused with copy that says what to do, never 'try again'", async () => {
    const stripe = stripeWith({ status: "paused", items: { data: [BASE] } });
    const err = await pushPlanChange({ stripe, logger }, args()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe(PLAN_CHANGE_SUBSCRIPTION_INACTIVE);
    expect((err as Error).message).not.toMatch(/try again/i);
  });
});

describe("runStripeFirstPlanChange as a schedule-time downgrade would call it", () => {
  const sub = {
    stripeSubId: "sub_1",
    planKey: "SCALE",
    priceOverrideMonthly: null,
    priceOverrideAnnual: null,
  };
  const version = { id: "v8", addonSkus: [] };
  const GROWTH = { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, annualPrice: null };
  const NO_ADDONS = { tenantAddon: { findMany: jest.fn().mockResolvedValue([]) } } as any;

  it("pushes the catalog price with none, then runs the local write", async () => {
    const stripe = stripeWith();
    const commit = jest.fn().mockResolvedValue("done");
    const out = await runStripeFirstPlanChange(
      { prisma: NO_ADDONS, stripe, logger },
      planChangeArgs({
        tenantId: "t1",
        sub,
        version,
        def: GROWTH,
        proration: "none",
        retireAddons: false,
      }),
      commit,
    );
    expect(out).toBe("done");
    expect(stripe.updateSubscription.mock.calls[0][1]).toMatchObject({
      proration_behavior: "none",
    });
    expect(stripe.updateSubscription.mock.calls[0][1].items[0].price_data.unit_amount).toBe(24900);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("the override WINS over the downgraded plan's price", async () => {
    const stripe = stripeWith();
    await runStripeFirstPlanChange(
      { prisma: NO_ADDONS, stripe, logger },
      planChangeArgs({
        tenantId: "t1",
        sub: { ...sub, priceOverrideMonthly: 180 },
        version,
        def: GROWTH,
        proration: "none",
        retireAddons: false,
      }),
      async () => undefined,
    );
    expect(stripe.updateSubscription.mock.calls[0][1].items[0].price_data.unit_amount).toBe(18000);
  });

  it("a tenant without a Stripe subscription runs the write with no Stripe read and no extra query", async () => {
    const stripe = stripeWith();
    const prisma = { tenantAddon: { findMany: jest.fn() } } as any;
    await runStripeFirstPlanChange(
      { prisma, stripe, logger },
      planChangeArgs({
        tenantId: "t1",
        sub: { ...sub, stripeSubId: null },
        version,
        def: GROWTH,
        proration: "none",
        retireAddons: false,
      }),
      async () => undefined,
    );
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.findMany).not.toHaveBeenCalled();
  });
});

describe("markNeedsReconcile (SEAM: the needsReconcile column ships with the B2/B3 migration)", () => {
  it("logs ONE ERROR-level structured alert with the tenant id, the idempotency key and both subscription states", () => {
    const log = { error: jest.fn() };
    markNeedsReconcile(log, {
      tenantId: "t1",
      stripeSubId: "sub_1",
      key: "t1:plan-change:v8:n",
      local: { planKey: "GROWTH" },
      stripe: { pushedPlanKey: "SCALE" },
      error: new Error("revert refused"),
    });

    expect(log.error).toHaveBeenCalledTimes(1);
    const msg = String(log.error.mock.calls[0][0]);
    expect(msg).toContain("billing.plan_change.needs_reconcile");
    expect(JSON.parse(msg.slice(msg.indexOf("{")))).toEqual({
      event: "billing.plan_change.needs_reconcile",
      severity: "ERROR",
      tenantId: "t1",
      stripeSubId: "sub_1",
      idempotencyKey: "t1:plan-change:v8:n",
      localState: { planKey: "GROWTH" },
      stripeState: { pushedPlanKey: "SCALE" },
      error: "revert refused",
    });
  });
});
