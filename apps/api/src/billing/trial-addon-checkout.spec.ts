/**
 * SA-690 option A — a trial's (or pilot's) add-ons are billed at the CARD CHECKOUT.
 *
 * Self-serve add-ons enabled before a tenant has a Stripe subscription are priced 0 and carry no
 * Stripe item ("never revenue we do not bill"). When that tenant pays by card, the checkout session
 * carries one extra line per such add-on; the completion webhook then ADOPTS the subscription item
 * Stripe made from each line onto its row (stripeItemId, the item's real unit price, its quantity) and
 * books each add-on's one stored → actual delta, AFTER the activation crossing priced the base plan.
 *
 * REAL stack, mocked at the module boundary: a real BillingService on a real
 * SubscriptionMutationService, an in-memory add-on table, a Stripe client that holds the
 * subscription's items. Stripe objects are shaped like the pinned API 2026-08-26.dahlia ones the
 * sandbox returns (see local-assets/stripe-optA/RESULTS.md).
 */
const mockWithAdvisoryLock = jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true as const,
  value: await fn(),
}));
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { ConflictException } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  CHECKOUT_ADDON_EXPAND,
  checkoutAddonItems,
  checkoutAddonLineItem,
  toCents,
} from "./stripe-addon-items";

const CATALOG = {
  addonSkus: [
    { sku: "CUSTOMER_PACK_100", name: "Customer pack (+100)", monthlyPrice: 50 },
    { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19, includedAtPlan: "SCALE" },
    { sku: "MSRP", name: "MSRP", monthlyPrice: 20 },
  ],
  definitions: [],
};

const PLAN_PRICE_DATA = {
  currency: "usd",
  product_data: { name: "RouteFlow Starter — monthly" },
  unit_amount: 9900,
  recurring: { interval: "month" },
};

let seq = 0;
interface RowOpts {
  qty?: number;
  active?: boolean;
  stripeItemId?: string | null;
  priceSnapshot?: number | null;
  addonKey?: string;
  createdAt?: Date;
}
const addonRow = (sku: string, o: RowOpts = {}) => ({
  id: `a${++seq}`,
  tenantId: "t1",
  addonKey: o.addonKey ?? sku,
  sku,
  quantity: o.qty ?? 1,
  active: o.active ?? true,
  priceSnapshot: o.priceSnapshot === undefined ? 0 : o.priceSnapshot,
  stripeItemId: o.stripeItemId ?? null,
  createdAt: o.createdAt ?? new Date(1_790_000_000_000 + seq),
});

/** The BASE plan item of a subscription, as dahlia returns it (period lives on the item). */
const baseItem = () => ({
  id: "si_base",
  object: "subscription_item",
  created: 1791172886,
  current_period_start: 1791172886,
  current_period_end: 1793851286,
  discounts: [],
  metadata: {},
  price: {
    id: "price_base",
    object: "price",
    currency: "usd",
    metadata: {},
    product: {
      id: "prod_base",
      object: "product",
      metadata: {},
      name: "RouteFlow Starter — monthly",
    },
    recurring: { interval: "month", interval_count: 1 },
    type: "recurring",
    unit_amount: 9900,
    unit_amount_decimal: "9900",
  },
  quantity: 1,
  subscription: "sub_1",
});

/** An add-on item the CHECKOUT made from a tagged `price_data` line (product expanded). */
const checkoutItem = (id: string, sku: string, cents: number, quantity: number) => ({
  id,
  object: "subscription_item",
  created: 1791172886,
  current_period_start: 1791172886,
  current_period_end: 1793851286,
  discounts: [],
  metadata: {},
  price: {
    id: `price_${id}`,
    object: "price",
    currency: "usd",
    metadata: {},
    product: {
      id: `prod_${id}`,
      object: "product",
      metadata: { addonSku: sku },
      name: `RouteFlow add-on — ${sku}`,
    },
    recurring: { interval: "month", interval_count: 1 },
    type: "recurring",
    unit_amount: cents,
    unit_amount_decimal: String(cents),
  },
  quantity,
  subscription: "sub_1",
});

interface Opts {
  status?: string;
  planKey?: string | null;
  tenantPlan?: string;
  interval?: "month" | "year" | null;
  rows?: ReturnType<typeof addonRow>[];
  /** Items the subscription holds when the completion webhook retrieves it. */
  items?: any[];
  /** The plan-transition flag (default off: the plain upsert path). */
  flagOn?: boolean;
  /** The session was already applied (flag-on redelivery). */
  alreadyApplied?: boolean;
  delFails?: boolean;
  baseSub?: Record<string, unknown>;
}

function make(opts: Opts = {}) {
  const tenant: any = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    status: opts.status ?? "TRIAL",
    class: "PRODUCTION",
    deletedAt: null,
    plan: opts.tenantPlan ?? "STARTER",
    planVersionId: "v1",
  };
  const sub: any = {
    tenantId: "t1",
    planKey: opts.planKey === undefined ? "STARTER" : opts.planKey,
    basePriceSnapshot: 99,
    discount: 0,
    stripeSubId: null,
    stripeCustomerId: "cus_1",
    billingInterval: opts.interval === undefined ? "month" : opts.interval,
    cycle: opts.interval === "year" ? "ANNUAL" : "MONTHLY",
    ...opts.baseSub,
  };
  const rows = opts.rows ?? [];

  // ── in-memory TenantAddon table ───────────────────────────────────────────────────────────────
  const matches = (r: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === "OR") {
        if (!(v as any[]).some((w) => matches(r, w))) return false;
      } else if (v && typeof v === "object" && !(v instanceof Date)) {
        const c = v as any;
        if ("in" in c && !c.in.includes(r[k])) return false;
        if ("not" in c && r[k] === c.not) return false;
      } else if (r[k] !== v) return false;
    }
    return true;
  };
  const tenantAddon = {
    findMany: jest.fn(async ({ where }: any = {}) =>
      rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    ),
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const hit = rows
        .filter((r) => matches(r, where))
        .sort(
          (a, b) =>
            Number(b.active) - Number(a.active) || a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
      return hit ? { ...hit } : null;
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      const hit = rows.find((r) => r.id === where.id);
      return hit ? { ...hit } : null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hits = rows.filter((r) => matches(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return { ...r };
    }),
  };

  // ── Stripe: the subscription's items live in `stripeItems` ───────────────────────────────────
  const stripeItems: any[] = [...(opts.items ?? [])];
  let itemSeq = 0;
  const client = {
    checkout: {
      sessions: { create: jest.fn().mockResolvedValue({ id: "cs_1", url: "https://pay" }) },
    },
    products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
    subscriptionItems: {
      list: jest.fn(async () => ({ data: [...stripeItems] })),
      create: jest.fn(async (args: any) => {
        const item = {
          id: `si_new${++itemSeq}`,
          metadata: args.metadata,
          quantity: args.quantity,
          subscription: args.subscription,
        };
        stripeItems.push(item);
        return item;
      }),
      update: jest.fn().mockResolvedValue({}),
      del: jest.fn(async (id: string) => {
        if (opts.delFails) throw new Error("stripe down: internal detail");
        const i = stripeItems.findIndex((x) => x.id === id);
        if (i >= 0) stripeItems.splice(i, 1);
        return {};
      }),
    },
    invoiceItems: { list: jest.fn().mockResolvedValue({ data: [] }) },
  };
  const stripeSubObject = () => ({
    id: "sub_1",
    object: "subscription",
    status: "active",
    items: { object: "list", data: stripeItems.map((i) => ({ ...i })) },
  });
  const stripe = {
    isConfigured: true,
    client,
    getSubscription: jest.fn(async () => stripeSubObject()),
    createCustomer: jest.fn().mockResolvedValue({ id: "cus_new" }),
  } as any;

  // ── ledger + transaction ───────────────────────────────────────────────────────────────────────
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const tx: any = {
    tenant: {
      // the activation CAS: TRIAL/READ_ONLY/... → ACTIVE, once
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where?.status?.not != null && tenant.status === where.status.not) return { count: 0 };
        tenant.status = data.status;
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({
        status: tenant.status,
        class: tenant.class,
        deletedAt: tenant.deletedAt,
        subscription: { planKey: sub.planKey },
      })),
    },
    tenantAddon,
    tenantSubscription: {
      upsert: jest.fn(async (args: any) => prisma.tenantSubscription.upsert(args)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({ ...tenant, subscription: { ...sub } })),
    },
    tenantSubscription: {
      findUnique: jest.fn(async () => ({ ...sub })),
      upsert: jest.fn(async ({ create, update }: any) => {
        Object.assign(sub, sub.stripeSubId || sub.stripeCustomerId ? update : create);
        return { ...sub };
      }),
    },
    tenantAddon,
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(opts.alreadyApplied ? { id: "audit1" } : null),
      create: jest.fn().mockResolvedValue({}),
    },
    tenantFeatureConfigSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };

  const entitlements = { invalidate: jest.fn() } as any;
  const planTransition = {
    isEnabled: jest.fn().mockResolvedValue(opts.flagOn ?? false),
    prepare: jest.fn().mockResolvedValue({ enabled: opts.flagOn ?? false }),
    onPlanChange: jest.fn().mockResolvedValue({ action: "none" }),
    invalidateCaches: jest.fn(),
    transactionOptions: jest.fn().mockReturnValue(undefined),
  } as any;
  const mutations = new SubscriptionMutationService(
    prisma,
    { getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG) } as any,
    {} as any,
    { getSubscription: jest.fn().mockResolvedValue({}) } as any,
    entitlements,
    events,
    { invalidate: jest.fn() } as any,
    stripe,
    {} as any,
    planTransition,
  );
  const pricing = {
    resolveTenantPricing: jest.fn().mockResolvedValue({
      planKey: "STARTER",
      planName: "Starter",
      monthly: 99,
      annual: 990,
      source: "catalog",
      currency: "usd",
    }),
    resolveCatalogPricing: jest.fn().mockResolvedValue({ planKey: "STARTER", monthly: 99 }),
    checkoutPriceData: jest.fn(async (_t: string, interval: string) => ({
      ...PLAN_PRICE_DATA,
      recurring: { interval },
      unit_amount: interval === "year" ? 99000 : 9900,
    })),
  } as any;
  const billing = new BillingService(
    prisma,
    stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    events,
    pricing,
    { notifyCheckoutPlanNotApplied: jest.fn() } as any,
    planTransition,
    mutations,
  );

  const session = (extra: Record<string, unknown> = {}) => ({
    id: "cs_1",
    object: "checkout.session",
    customer: "cus_1",
    subscription: "sub_1",
    created: 1791172800,
    metadata: { tenantId: "t1", slug: "acme", planKey: "STARTER", interval: "month" },
    ...extra,
  });
  /** The checkout.session.completed handler, exactly as the webhook controller dispatches it. */
  const completed = (s = session()) =>
    billing.handleWebhookEvent({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: s },
    });
  const ledger = () =>
    events.emit.mock.calls.map((c: any[]) => ({
      type: c[1],
      delta: c[3]?.amountDelta,
      sku: c[2]?.sku,
    }));
  const ledgerSum = () => ledger().reduce((s: number, e: any) => s + Number(e.delta ?? 0), 0);
  const stripeNoCalls = () =>
    expect(client.checkout.sessions.create).not.toHaveBeenCalled() ||
    expect(stripe.getSubscription).not.toHaveBeenCalled() ||
    expect(stripe.createCustomer).not.toHaveBeenCalled();

  return {
    billing,
    mutations,
    prisma,
    tx,
    tenant,
    sub,
    rows,
    client,
    stripe,
    stripeItems,
    events,
    entitlements,
    session,
    completed,
    ledger,
    ledgerSum,
    stripeNoCalls,
  };
}

const ADDON_TYPES = [BILLING_EVENTS.ADDON_ENABLED, BILLING_EVENTS.ADDON_DISABLED];

beforeEach(() => {
  mockWithAdvisoryLock.mockClear();
  seq = 0;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("SA-690 checkout — the unbilled add-ons ride the card checkout", () => {
  it("builds 1 plan line + 1 line per unbilled active add-on (qty, integer cents, tagged product)", async () => {
    const h = make({
      rows: [addonRow("FORECASTING", { qty: 1 }), addonRow("CUSTOMER_PACK_100", { qty: 2 })],
    });

    await h.billing.createCheckoutSession("t1", "month");

    const args = h.client.checkout.sessions.create.mock.calls[0][0];
    expect(args.mode).toBe("subscription");
    expect(args.line_items).toEqual([
      { price_data: PLAN_PRICE_DATA, quantity: 1 },
      {
        price_data: {
          currency: "usd",
          unit_amount: 5000,
          recurring: { interval: "month" },
          product_data: {
            name: "RouteFlow add-on — Customer pack (+100)",
            metadata: { addonSku: "CUSTOMER_PACK_100" },
          },
        },
        quantity: 2,
      },
      {
        price_data: {
          currency: "usd",
          unit_amount: 1900,
          recurring: { interval: "month" },
          product_data: {
            name: "RouteFlow add-on — Forecasting",
            metadata: { addonSku: "FORECASTING" },
          },
        },
        quantity: 1,
      },
    ]);
  });

  it("puts the SKUs in the session metadata AND the subscription metadata", async () => {
    const h = make({ rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 }), addonRow("FORECASTING")] });

    await h.billing.createCheckoutSession("t1", "month");

    const args = h.client.checkout.sessions.create.mock.calls[0][0];
    expect(args.metadata).toEqual({
      tenantId: "t1",
      slug: "acme",
      planKey: "STARTER",
      interval: "month",
      addonSkus: "CUSTOMER_PACK_100,FORECASTING",
    });
    expect(args.subscription_data).toEqual({
      metadata: { tenantId: "t1", addonSkus: "CUSTOMER_PACK_100,FORECASTING" },
    });
  });

  it("bills only what is active, self-serve, unbilled and not already bundled by the plan", async () => {
    const h = make({
      rows: [
        addonRow("CUSTOMER_PACK_100", { stripeItemId: "si_billed" }), // already on a Stripe item
        addonRow("FORECASTING", { active: false }), // switched off
        addonRow("MSRP"), // admin-only SKU (ships dark) — never self-serve billed here
        addonRow("SEAT_EXTRA", { qty: 3 }), // seat plumbing, not a self-serve toggle
        addonRow("CUSTOMER_PACK_100", { qty: 4, addonKey: "extra_pack" }), // the ONE billable row
      ],
    });
    await h.billing.createCheckoutSession("t1", "month");
    const lines = h.client.checkout.sessions.create.mock.calls[0][0].line_items;
    expect(lines).toHaveLength(2); // the plan + the one billable add-on
    expect(lines[1].quantity).toBe(4);

    // a SKU the plan already bundles is never sold again (F3), so it gets no line either
    const bundled = make({
      rows: [addonRow("FORECASTING")],
      tenantPlan: "BUSINESS",
      planKey: "SCALE",
    });
    await bundled.billing.createCheckoutSession("t1", "month");
    expect(bundled.client.checkout.sessions.create.mock.calls[0][0].line_items).toHaveLength(1);
  });

  it("refuses an ANNUAL checkout that would bill an add-on: 409 ADDON_ANNUAL_NOT_SUPPORTED, no Stripe call", async () => {
    const h = make({ rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })] });

    const err: any = await h.billing.createCheckoutSession("t1", "year").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED });
    expect(h.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(h.stripe.getSubscription).not.toHaveBeenCalled();
    expect(h.stripe.createCustomer).not.toHaveBeenCalled();
  });

  it("a checkout with no unbilled add-on is exactly the plan line (monthly and annual): no tags", async () => {
    const monthly = make({ rows: [] });
    await monthly.billing.createCheckoutSession("t1", "month");
    const m = monthly.client.checkout.sessions.create.mock.calls[0][0];
    expect(m.line_items).toEqual([{ price_data: PLAN_PRICE_DATA, quantity: 1 }]);
    expect(m.metadata).toEqual({
      tenantId: "t1",
      slug: "acme",
      planKey: "STARTER",
      interval: "month",
    });
    expect(m).not.toHaveProperty("subscription_data");

    const annual = make({ rows: [addonRow("CUSTOMER_PACK_100", { stripeItemId: "si_billed" })] });
    await annual.billing.createCheckoutSession("t1", "year");
    expect(annual.client.checkout.sessions.create.mock.calls[0][0].line_items).toHaveLength(1);
  });

  it("a legacy row keyed by addonKey is billed under its canonical SKU, once", async () => {
    // two ACTIVE rows for one SKU (pre-#2188 data) must never become two lines
    const h = make({
      rows: [
        addonRow("CUSTOMER_PACK_100", { qty: 2 }),
        addonRow("CUSTOMER_PACK_100", { qty: 5, addonKey: "customer_pack_100_legacy" }),
      ],
    });
    await h.billing.createCheckoutSession("t1", "month");
    const lines = h.client.checkout.sessions.create.mock.calls[0][0].line_items;
    expect(lines).toHaveLength(2);
    expect(lines[1].quantity).toBe(2); // the oldest row — the same pick findAddonRow makes
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("SA-690 completion — adopt each checkout item onto its row, once", () => {
  it("adopts the item: stripeItemId, Stripe's actual unit price, the item's quantity; one add-on delta", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })],
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
    });

    await h.completed();

    expect(h.stripe.getSubscription).toHaveBeenCalledWith("sub_1", {
      expand: CHECKOUT_ADDON_EXPAND,
    });
    expect(h.rows[0]).toMatchObject({
      stripeItemId: "si_pack",
      priceSnapshot: 50,
      quantity: 2,
      active: true,
    });
    const adds = h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type));
    expect(adds).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
    ]);
    expect(h.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("the row takes STRIPE's unit price and quantity, not the catalog's or the row's", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 4500, 1)],
    });
    await h.completed();
    expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 45, quantity: 1 });
    expect(h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 45, sku: "CUSTOMER_PACK_100" },
    ]);
  });

  it("a REDELIVERED webhook finds the item already set: no write, no Stripe call, NOTHING booked", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })],
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
    });
    await h.completed();
    expect(h.rows[0].stripeItemId).toBe("si_pack"); // adopted by the first delivery
    const afterFirst = h.ledger();
    expect(afterFirst.some((e: any) => e.type === BILLING_EVENTS.ADDON_ENABLED)).toBe(true);
    h.tx.tenantAddon.updateMany.mockClear();
    h.entitlements.invalidate.mockClear();

    await h.completed();

    expect(h.ledger()).toEqual(afterFirst);
    expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("BOOKING ORDER: the activation crossing prices the base at stored snapshots FIRST, then the adoption delta — each once", async () => {
    const h = make({
      status: "TRIAL",
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 }), addonRow("FORECASTING", { qty: 1 })],
      items: [
        baseItem(),
        checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2),
        checkoutItem("si_fc", "FORECASTING", 1900, 1),
      ],
    });

    await h.completed();

    expect(h.ledger()).toEqual([
      // the crossing: base 99 + stored add-ons (0 each) — the trial add-ons were free until now
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99, sku: undefined },
      // then each add-on's stored → actual delta
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 19, sku: "FORECASTING" },
    ]);
    // the run-rate the ledger now carries == what Stripe bills monthly: 99 + 2×50 + 19
    expect(h.ledgerSum()).toBe(99 + 100 + 19);
    expect(h.tenant.status).toBe("ACTIVE");
  });

  it("books stored → ACTUAL: a row already carrying a snapshot is netted, never double-counted by the crossing", async () => {
    const h = make({
      status: "TRIAL",
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 1, priceSnapshot: 12 })], // a legacy priced row
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 1)],
    });
    await h.completed();
    expect(h.ledger()).toEqual([
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99 + 12, sku: undefined }, // the crossing counted the stored 12
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 38, sku: "CUSTOMER_PACK_100" }, // 50 − 12, once
    ]);
    expect(h.ledgerSum()).toBe(99 + 50);
  });

  it("serialises each add-on under the shared billing lock addon:<tenant>:<sku>", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100"), addonRow("FORECASTING")],
      items: [
        baseItem(),
        checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 1),
        checkoutItem("si_fc", "FORECASTING", 1900, 1),
      ],
    });
    await h.completed();
    const keys = mockWithAdvisoryLock.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([
      expect.objectContaining({ family: "billing", key: "addon:t1:CUSTOMER_PACK_100" }),
      expect.objectContaining({ family: "billing", key: "addon:t1:FORECASTING" }),
    ]);
  });

  it("is the base plan item that sets the period, never a checkout add-on item", async () => {
    // Stripe does not order items base-first: an add-on item can come first
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100")],
      items: [
        { ...checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 1), current_period_end: 1 },
        baseItem(),
      ],
    });
    await h.completed();
    const upsert = h.prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect((upsert.update ?? upsert.create).periodEnd).toEqual(new Date(1793851286 * 1000));
  });

  describe("orphans — never two items per SKU, never an item nothing owns", () => {
    it("(a) the row went INACTIVE between session and completion: the item is deleted Stripe-first, with prorations; nothing booked", async () => {
      const h = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 2, active: false })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });

      await h.completed();

      expect(h.client.subscriptionItems.del).toHaveBeenCalledWith("si_pack", {
        proration_behavior: "create_prorations",
      });
      expect(h.stripeItems.map((i) => i.id)).toEqual(["si_base"]);
      expect(h.rows[0]).toMatchObject({ active: false, stripeItemId: null, priceSnapshot: 0 });
      expect(h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([]);
    });

    it("(a) no row at all for the SKU: the item is deleted too", async () => {
      const h = make({
        rows: [],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 1)],
      });
      await h.completed();
      expect(h.client.subscriptionItems.del).toHaveBeenCalledWith("si_pack", {
        proration_behavior: "create_prorations",
      });
    });

    it("(b) the row already holds a DIFFERENT item: the row's item stays, the new one is deleted; nothing booked", async () => {
      const h = make({
        rows: [
          addonRow("CUSTOMER_PACK_100", { qty: 2, stripeItemId: "si_old", priceSnapshot: 50 }),
        ],
        items: [
          baseItem(),
          {
            ...checkoutItem("si_old", "X", 5000, 2),
            price: { ...baseItem().price, product: { metadata: {} } },
          },
          checkoutItem("si_new", "CUSTOMER_PACK_100", 5000, 2),
        ],
      });

      await h.completed();

      expect(h.client.subscriptionItems.del).toHaveBeenCalledTimes(1);
      expect(h.client.subscriptionItems.del).toHaveBeenCalledWith("si_new", {
        proration_behavior: "create_prorations",
      });
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_old", priceSnapshot: 50, quantity: 2 });
      expect(h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([]);
    });

    it("(c) an ACTIVE row with no item (enabled after the session was created): the enable path bills it — one item, catalog price, one delta", async () => {
      const h = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })],
        items: [baseItem()], // the session had no line for it
      });

      await h.completed();

      expect(h.client.subscriptionItems.list).toHaveBeenCalled(); // adoptOrphanItem first
      expect(h.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect(h.client.subscriptionItems.create.mock.calls[0][0]).toMatchObject({
        subscription: "sub_1",
        quantity: 2,
        proration_behavior: "create_prorations",
        price_data: {
          currency: "usd",
          unit_amount: 5000,
          recurring: { interval: "month" },
          product: "prod_new",
        },
        metadata: { tenantId: "t1", sku: "CUSTOMER_PACK_100" },
      });
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_new1", priceSnapshot: 50, quantity: 2 });
      expect(h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([
        { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
      ]);
    });

    it("(c) adopts an unreferenced matching item instead of creating a second one", async () => {
      const lost = {
        id: "si_lost",
        metadata: { tenantId: "t1", sku: "CUSTOMER_PACK_100" },
        quantity: 2,
        subscription: "sub_1",
      };
      const h = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })],
        items: [baseItem(), lost],
      });
      await h.completed();
      expect(h.client.subscriptionItems.create).not.toHaveBeenCalled();
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_lost", priceSnapshot: 50 });
    });

    it("(c) is skipped on an annual checkout and for an add-on the plan already bundles", async () => {
      const annual = make({
        interval: "year",
        rows: [addonRow("CUSTOMER_PACK_100")],
        items: [baseItem()],
      });
      await annual.completed(
        annual.session({ metadata: { tenantId: "t1", planKey: "STARTER", interval: "year" } }),
      );
      expect(annual.client.subscriptionItems.create).not.toHaveBeenCalled();
      expect(annual.rows[0].stripeItemId).toBeNull();

      const bundled = make({
        rows: [addonRow("FORECASTING")],
        tenantPlan: "BUSINESS",
        planKey: "SCALE",
        items: [baseItem()],
      });
      await bundled.completed();
      expect(bundled.client.subscriptionItems.create).not.toHaveBeenCalled();
    });

    it("a Stripe failure while deleting an orphan FAILS the webhook (Stripe redelivers) and books nothing; the retry completes", async () => {
      const failing = make({
        rows: [addonRow("CUSTOMER_PACK_100", { active: false })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 1)],
        delFails: true,
      });
      await expect(failing.completed()).rejects.toBeDefined();
      expect(failing.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([]);
      // the item is still on the subscription: nothing hid it
      expect(failing.stripeItems.map((i) => i.id)).toContain("si_pack");
    });
  });

  it("one SKU failing does not strand the others: the rest are adopted, then the webhook fails for the retry", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100", { active: false }), addonRow("FORECASTING")],
      items: [
        baseItem(),
        checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 1), // orphan whose delete fails
        checkoutItem("si_fc", "FORECASTING", 1900, 1),
      ],
      delFails: true,
    });
    await expect(h.completed()).rejects.toBeDefined();
    expect(h.rows[1]).toMatchObject({ stripeItemId: "si_fc", priceSnapshot: 19 });
  });

  it("flag ON, session already applied: a redelivery STILL adopts (an earlier attempt may have failed on Stripe after the plan applied)", async () => {
    const h = make({
      flagOn: true,
      alreadyApplied: true,
      status: "ACTIVE",
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })],
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
    });

    await h.completed();

    expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 50 });
    expect(h.ledger()).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
    ]);
    // …and the plan itself was NOT re-applied
    expect(h.prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
  });

  it("a plan-only checkout (no add-on rows, no add-on items) adopts nothing and touches no Stripe item", async () => {
    const h = make({ rows: [], items: [baseItem()] });
    await h.completed();
    expect(h.client.subscriptionItems.list).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.ledger()).toEqual([
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99, sku: undefined },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("SA-690 pure helpers", () => {
  it("cents are integers whatever the float noise", () => {
    expect(toCents(50)).toBe(5000);
    expect(toCents("19.00")).toBe(1900);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(12.345)).toBe(1235);
  });

  it("the line item is a monthly inline price tagged on its product", () => {
    expect(
      checkoutAddonLineItem({
        sku: "FORECASTING",
        name: "Forecasting",
        monthlyPrice: "19",
        quantity: 3,
      }),
    ).toEqual({
      price_data: {
        currency: "usd",
        unit_amount: 1900,
        recurring: { interval: "month" },
        product_data: {
          name: "RouteFlow add-on — Forecasting",
          metadata: { addonSku: "FORECASTING" },
        },
      },
      quantity: 3,
    });
  });

  it("finds only the add-on items: not the base, not an in-app enable item, tolerant of an unexpanded product", () => {
    const sub = {
      items: {
        data: [
          baseItem(),
          checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2),
          {
            id: "si_enable",
            metadata: { tenantId: "t1", sku: "FORECASTING" },
            quantity: 1,
            price: { product: "prod_x" },
          },
          { id: "si_unexpanded", quantity: 1, price: { product: "prod_y", unit_amount: 100 } },
          {
            ...checkoutItem("si_dec", "FORECASTING", 0, 1),
            price: {
              product: { metadata: { addonSku: "FORECASTING" } },
              unit_amount: null,
              unit_amount_decimal: "1900.4",
            },
          },
        ],
      },
    };
    expect(checkoutAddonItems(sub)).toEqual([
      { itemId: "si_pack", sku: "CUSTOMER_PACK_100", quantity: 2, unitAmountCents: 5000 },
      { itemId: "si_dec", sku: "FORECASTING", quantity: 1, unitAmountCents: 1900 },
    ]);
    expect(checkoutAddonItems(null)).toEqual([]);
  });
});
