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
/** A keyed mutex, like the real advisory lock: callers on one key run one at a time, in arrival order. */
const lockTails = new Map<string, Promise<unknown>>();
const mockWithAdvisoryLock = jest.fn(async (opts: { key: string }, fn: () => Promise<unknown>) => {
  const prior = lockTails.get(opts.key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((res) => (release = res));
  lockTails.set(
    opts.key,
    prior.then(() => mine),
  );
  await prior;
  try {
    return { acquired: true as const, value: await fn() };
  } finally {
    release();
  }
});
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { ConflictException, Logger } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import { SettingsBillingController } from "./settings-billing.controller";
import { PlatformAdminController } from "../platform-admin/platform-admin.controller";
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
  sku: sku as string | null,
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
    recurring: {
      interval: "month",
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    },
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
    recurring: {
      interval: "month",
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    },
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
  updateFails?: boolean;
  baseSub?: Record<string, unknown>;
  /** The customer RouteFlow stored for the tenant (default cus_1; null = none on file). */
  storedCustomer?: string | null;
  /** The customer on the Stripe subscription the completion retrieves (default cus_1). */
  subCustomer?: string;
  /** The retrieved subscription's status (default active). */
  subStatus?: string;
  /** A DOWNGRADE snapshot taken after the session was created (the stale-checkout branch). */
  newerDowngrade?: boolean;
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
    stripeCustomerId: opts.storedCustomer === undefined ? "cus_1" : opts.storedCustomer,
    billingInterval: opts.interval === undefined ? "month" : opts.interval,
    cycle: opts.interval === "year" ? "ANNUAL" : "MONTHLY",
    ...opts.baseSub,
  };
  const rows = opts.rows ?? [];
  let customerSeq = 0;

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
      update: jest.fn(async (id: string, args: any) => {
        if (opts.updateFails) throw new Error("stripe down: internal detail");
        const i = stripeItems.find((x) => x.id === id);
        if (i && args?.quantity != null) i.quantity = args.quantity;
        return { id };
      }),
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
    status: opts.subStatus ?? "active",
    customer: opts.subCustomer ?? "cus_1",
    items: { object: "list", data: stripeItems.map((i) => ({ ...i })) },
  });
  const stripe = {
    isConfigured: true,
    client,
    getSubscription: jest.fn(async () => stripeSubObject()),
    createCustomer: jest.fn(async () => {
      await new Promise((r) => setImmediate(r)); // a real network hop: lets a concurrent caller interleave
      return { id: `cus_new${++customerSeq}` };
    }),
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
      findUnique: jest.fn(async () => ({
        ...tenant,
        subscription: { ...sub },
        config: { businessName: "Acme Foods" },
      })),
    },
    tenantSubscription: {
      findUnique: jest.fn(async () => ({ ...sub })),
      upsert: jest.fn(async ({ create, update }: any) => {
        Object.assign(sub, sub.stripeSubId || sub.stripeCustomerId ? update : create);
        return { ...sub };
      }),
    },
    tenantAddon,
    user: { findFirst: jest.fn().mockResolvedValue({ email: "admin@acme.test" }) },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(opts.alreadyApplied ? { id: "audit1" } : null),
      create: jest.fn().mockResolvedValue({}),
    },
    tenantFeatureConfigSnapshot: {
      findFirst: jest.fn().mockResolvedValue(opts.newerDowngrade ? { id: "snap-newer" } : null),
    },
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
  const billingNotification = { notifyCheckoutPlanNotApplied: jest.fn() } as any;
  const billing = new BillingService(
    prisma,
    stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    events,
    pricing,
    billingNotification,
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
    billingNotification,
    session,
    completed,
    ledger,
    ledgerSum,
  };
}

const ADDON_TYPES = [BILLING_EVENTS.ADDON_ENABLED, BILLING_EVENTS.ADDON_DISABLED];

beforeEach(() => {
  lockTails.clear();
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
        addonRow("FORECASTING", { stripeItemId: "si_billed" }), // already on a Stripe item
        addonRow("CUSTOMER_PACK_100", { active: false }), // switched off
        addonRow("MSRP"), // admin-only SKU (ships dark) — never self-serve billed here
        addonRow("SEAT_EXTRA", { qty: 3 }), // seat plumbing, not a self-serve toggle
        addonRow("CUSTOMER_PACK_100", { qty: 4, addonKey: "extra_pack" }), // the ONE billable row
      ],
    });
    await h.billing.createCheckoutSession("t1", "month");
    const lines = h.client.checkout.sessions.create.mock.calls[0][0].line_items;
    expect(lines).toHaveLength(2); // the plan + the one billable add-on
    expect(lines[1].quantity).toBe(4);

    // never a SECOND line for a SKU that already holds an item through another active row
    const dup = make({
      rows: [
        addonRow("CUSTOMER_PACK_100", { stripeItemId: "si_billed" }),
        addonRow("CUSTOMER_PACK_100", { addonKey: "extra_pack" }),
      ],
    });
    await dup.billing.createCheckoutSession("t1", "month");
    expect(dup.client.checkout.sessions.create.mock.calls[0][0].line_items).toHaveLength(1);

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

  it("the row takes STRIPE's unit price (not the catalog's) and keeps its OWN quantity (3, not the item's 1)", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 4500, 1)],
    });
    await h.completed();
    expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 45, quantity: 3 });
    // the item is brought UP to the row's quantity (billed), never the row down to the item's
    expect(h.client.subscriptionItems.update).toHaveBeenCalledWith("si_pack", {
      quantity: 3,
      proration_behavior: "create_prorations",
    });
    // adoption 0 → 45×1, then the raise 1 → 3 at 45: 135 = 45×3 in all
    expect(
      h
        .ledger()
        .filter((e: any) => ADDON_TYPES.includes(e.type))
        .map((e: any) => e.delta),
    ).toEqual([45, 90]);
  });

  it("equal quantities: nothing to reconcile — no Stripe update", async () => {
    const h = make({
      rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })],
      items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 4500, 2)],
    });
    await h.completed();
    expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 45, quantity: 2 });
    expect(h.client.subscriptionItems.update).not.toHaveBeenCalled();
  });

  describe("the ROW's quantity wins: Stripe is brought to it through the billed quantity-change path", () => {
    const events = (h: ReturnType<typeof make>) =>
      h.ledger().filter((e: any) => e.sku === "CUSTOMER_PACK_100");

    it("row 3 / item 2: the item is updated to 3 with prorations, the row stays 3, and +50 is booked for the raise", async () => {
      const h = make({
        status: "TRIAL",
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });

      await h.completed();

      expect(h.client.subscriptionItems.update).toHaveBeenCalledTimes(1);
      expect(h.client.subscriptionItems.update).toHaveBeenCalledWith("si_pack", {
        quantity: 3,
        proration_behavior: "create_prorations",
      });
      expect(h.stripeItems.find((i) => i.id === "si_pack")?.quantity).toBe(3);
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 50, quantity: 3 });
      // the adoption (stored 0 → 50×2) then the raise (2 → 3 at 50): 150 = 50×3 in all, never retro-billed
      expect(events(h).map((e: any) => e.delta)).toEqual([100, 50]);
      expect(h.ledgerSum()).toBe(99 + 150);
    });

    it("row 1 / item 2: the item is updated to 1 with prorations (a credit), the row stays 1, and -50 is booked", async () => {
      const h = make({
        status: "TRIAL",
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 1 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });

      await h.completed();

      expect(h.client.subscriptionItems.update).toHaveBeenCalledWith("si_pack", {
        quantity: 1,
        proration_behavior: "create_prorations",
      });
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 50, quantity: 1 });
      expect(events(h).map((e: any) => e.delta)).toEqual([100, -50]);
      expect(h.ledgerSum()).toBe(99 + 50);
    });

    it("the quantity change is labelled by the money it moves: a positive delta is addon.enabled, a negative one addon.disabled", async () => {
      const raise = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });
      await raise.completed();
      expect(events(raise).map((e: any) => e.type)).toEqual([
        BILLING_EVENTS.ADDON_ENABLED,
        BILLING_EVENTS.ADDON_ENABLED,
      ]);

      const cut = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 1 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });
      await cut.completed();
      expect(events(cut).map((e: any) => e.type)).toEqual([
        BILLING_EVENTS.ADDON_ENABLED, // adoption: +100
        BILLING_EVENTS.ADDON_DISABLED, // the reduce: -50
      ]);

      // a quantity that SHRANK while the money is POSITIVE (stored 0×3 → 45×1) is still addon.enabled
      const shrinkPositive = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 4500, 1)],
      });
      await shrinkPositive.completed();
      expect(events(shrinkPositive).map((e: any) => [e.type, e.delta])).toEqual([
        [BILLING_EVENTS.ADDON_ENABLED, 45],
        [BILLING_EVENTS.ADDON_ENABLED, 90],
      ]);
    });

    it("a Stripe failure updating the quantity fails the webhook and leaves the row unadopted and unbooked", async () => {
      const h = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
        updateFails: true,
      });
      await expect(h.completed()).rejects.toBeDefined();
      expect(h.rows[0]).toMatchObject({ stripeItemId: null, priceSnapshot: 0, quantity: 3 });
      expect(h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([]);
    });

    it("a redelivery after a reconcile changes nothing (no second update, nothing booked)", async () => {
      const h = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });
      await h.completed();
      const ledger = h.ledger();
      h.client.subscriptionItems.update.mockClear();
      await h.completed();
      expect(h.ledger()).toEqual(ledger);
      expect(h.client.subscriptionItems.update).not.toHaveBeenCalled();
    });

    it("the row's quantity changed between the Stripe update and the write: nothing is adopted, the webhook fails and the retry reconciles", async () => {
      const h = make({
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });
      h.client.subscriptionItems.update.mockImplementationOnce(async (id: string, args: any) => {
        h.rows[0].quantity = 4; // a concurrent writer raised it after we read the row
        const i = h.stripeItems.find((x) => x.id === id);
        if (i) i.quantity = args.quantity;
        return { id };
      });
      await expect(h.completed()).rejects.toBeDefined();
      expect(h.rows[0].stripeItemId).toBeNull();

      await h.completed(); // the retry: the item is brought to 4
      expect(h.client.subscriptionItems.update).toHaveBeenLastCalledWith("si_pack", {
        quantity: 4,
        proration_behavior: "create_prorations",
      });
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", quantity: 4 });
    });
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
      // the checkout names the bundling plan too (it is what the completion writes onto the row)
      await bundled.completed(
        bundled.session({ metadata: { tenantId: "t1", planKey: "SCALE", interval: "month" } }),
      );
      expect(bundled.client.subscriptionItems.create).not.toHaveBeenCalled();
      expect(bundled.rows[0].stripeItemId).toBeNull();
    });

    it("(c) PIN: an add-on enabled (and a quantity raised) AFTER the session was created is billed once — one item per SKU, no double booking, even redelivered", async () => {
      // The session was created with CUSTOMER_PACK_100 only (its line became si_pack). Before the
      // card was entered the tenant also enabled FORECASTING — a row with no item and no session line —
      // and raised CUSTOMER_PACK_100's quantity from 2 to 3.
      const h = make({
        status: "TRIAL",
        rows: [addonRow("CUSTOMER_PACK_100", { qty: 3 }), addonRow("FORECASTING", { qty: 1 })],
        items: [baseItem(), checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2)],
      });

      await h.completed();

      // FORECASTING: the existing enable path — adoptOrphanItem (a listing) first, then ONE create
      expect(h.client.subscriptionItems.list).toHaveBeenCalledTimes(1);
      expect(h.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect(h.client.subscriptionItems.create.mock.calls[0][0]).toMatchObject({
        subscription: "sub_1",
        quantity: 1,
        proration_behavior: "create_prorations",
        price_data: { unit_amount: 1900, recurring: { interval: "month" } },
        metadata: { tenantId: "t1", sku: "FORECASTING" },
      });
      expect(h.rows[1]).toMatchObject({ stripeItemId: "si_new1", priceSnapshot: 19, quantity: 1 });
      // CUSTOMER_PACK_100: adopted, and the ROW's later quantity (3) wins — the item (2) is raised to it
      expect(h.client.subscriptionItems.update).toHaveBeenCalledWith("si_pack", {
        quantity: 3,
        proration_behavior: "create_prorations",
      });
      expect(h.rows[0]).toMatchObject({ stripeItemId: "si_pack", priceSnapshot: 50, quantity: 3 });
      // crossing first (stored 0s), then the adoption (+100) and the raise (+50) for the pack, then
      // the forecasting item; nothing twice
      expect(h.ledger().map((e: any) => [e.sku ?? e.type, e.delta])).toEqual([
        [BILLING_EVENTS.SUBSCRIPTION_RESUMED, 99],
        ["CUSTOMER_PACK_100", 100],
        ["CUSTOMER_PACK_100", 50],
        ["FORECASTING", 19],
      ]);
      // exactly one item per SKU on the subscription
      expect(h.stripeItems.map((i) => i.id).sort()).toEqual(["si_base", "si_new1", "si_pack"]);

      // a redelivery of the same webhook changes nothing anywhere
      const ledger = h.ledger();
      h.client.subscriptionItems.create.mockClear();
      h.client.subscriptionItems.del.mockClear();
      h.client.subscriptionItems.update.mockClear();
      await h.completed();
      expect(h.ledger()).toEqual(ledger);
      expect(h.client.subscriptionItems.create).not.toHaveBeenCalled();
      expect(h.client.subscriptionItems.del).not.toHaveBeenCalled();
      expect(h.client.subscriptionItems.update).not.toHaveBeenCalled();
      expect(h.stripeItems).toHaveLength(3);
    });

    it("(c) a failure creating the item leaves the row unbilled and unbooked, and fails the webhook", async () => {
      const h = make({ rows: [addonRow("FORECASTING")], items: [baseItem()] });
      h.client.subscriptionItems.create.mockRejectedValueOnce(new Error("stripe down"));
      await expect(h.completed()).rejects.toBeDefined();
      expect(h.rows[0]).toMatchObject({ stripeItemId: null, priceSnapshot: 0 });
      expect(h.ledger().filter((e: any) => ADDON_TYPES.includes(e.type))).toEqual([]);
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
describe("SA-690 completion — the customer must be the tenant's, flag on or off", () => {
  /**
   * The signature proves the Stripe account, not that RouteFlow created the session, and the add-on
   * adoption writes rows and creates/deletes Stripe items from `session.metadata.tenantId`. Before
   * anything is written the tenant's STORED customer, the session's customer and the retrieved
   * subscription's customer must be the same one — whatever the plan-transition flag says (it fails
   * closed to OFF). A mismatch changes nothing, logs the ids, leaves a trail row and answers 200.
   */
  const itemsOf = () => [
    baseItem(),
    checkoutItem("si_pack", "CUSTOMER_PACK_100", 5000, 2),
    checkoutItem("si_fc", "FORECASTING", 1900, 1),
  ];
  const rowsOf = () => [addonRow("CUSTOMER_PACK_100", { qty: 2 }), addonRow("FORECASTING")];

  const expectUntouched = (h: ReturnType<typeof make>, status = "TRIAL") => {
    expect(
      h.rows.map((r) => [r.stripeItemId, Number(r.priceSnapshot), r.quantity, r.active]),
    ).toEqual([
      [null, 0, 2, true],
      [null, 0, 1, true],
    ]);
    expect(h.ledger()).toEqual([]);
    expect(h.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.update).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.client.subscriptionItems.list).not.toHaveBeenCalled();
    expect(h.prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(h.tenant.status).toBe(status);
    expect(h.entitlements.invalidate).not.toHaveBeenCalled();
  };

  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());

  it("a FORGED session naming tenant t1 (another customer): adopts nothing, writes nothing, resolves, logs the ids, leaves a trail row", async () => {
    const h = make({ rows: rowsOf(), items: itemsOf(), subCustomer: "cus_attacker" });

    await expect(h.completed(h.session({ customer: "cus_attacker" }))).resolves.toBeUndefined();

    expectUntouched(h);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(/t1.*cs_1.*cus_1.*cus_attacker|cs_1.*t1/s),
    );
    const logged = errorLog.mock.calls.map((c) => String(c[0])).join("\n");
    for (const id of ["t1", "cs_1", "cus_1", "cus_attacker"]) expect(logged).toContain(id);
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t1",
        action: "STRIPE_CHECKOUT_REFUSED",
        entityType: "stripe_checkout_session",
        entityId: "cs_1",
        meta: expect.objectContaining({
          reason: "customer_mismatch",
          storedCustomer: "cus_1",
          sessionCustomer: "cus_attacker",
          subscriptionCustomer: "cus_attacker",
          subscriptionId: "sub_1",
          addonItemIds: ["si_fc", "si_pack"],
        }),
      }),
    });
  });

  it.each([
    [
      "the session's customer is not the stored one",
      { subCustomer: "cus_2" },
      { customer: "cus_2" },
    ],
    ["the SUBSCRIPTION's customer is not the session's", { subCustomer: "cus_2" }, {}],
    ["no customer is on file for the tenant", { storedCustomer: null }, {}],
  ] as const)("refused, same outcome: %s", async (_name, opts, sessionExtra) => {
    const h = make({ rows: rowsOf(), items: itemsOf(), ...opts });
    await expect(h.completed(h.session({ ...sessionExtra }))).resolves.toBeUndefined();
    expectUntouched(h);
    expect(errorLog).toHaveBeenCalled();
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("the plan write is refused too (a forged session never re-points the tenant's subscription)", async () => {
    const h = make({ rows: rowsOf(), items: itemsOf(), subCustomer: "cus_attacker" });
    await h.completed(h.session({ customer: "cus_attacker" }));
    expect(h.sub.stripeSubId).toBeNull();
    expect(h.sub.stripeCustomerId).toBe("cus_1");
  });

  it("flag ON: the same refusals (subscription customer differs; already-applied redelivery included)", async () => {
    const mismatchSub = make({
      flagOn: true,
      rows: rowsOf(),
      items: itemsOf(),
      subCustomer: "cus_2",
    });
    await expect(mismatchSub.completed()).resolves.toBeUndefined();
    expectUntouched(mismatchSub);

    const redelivery = make({
      flagOn: true,
      alreadyApplied: true,
      rows: rowsOf(),
      items: itemsOf(),
      subCustomer: "cus_2",
    });
    await expect(redelivery.completed()).resolves.toBeUndefined();
    expectUntouched(redelivery);

    const noneOnFile = make({
      flagOn: true,
      alreadyApplied: true,
      rows: rowsOf(),
      items: itemsOf(),
      storedCustomer: null,
    });
    await expect(noneOnFile.completed()).resolves.toBeUndefined();
    expectUntouched(noneOnFile);
  });

  it("one trail row per session: a second refused delivery finds the first and writes none", async () => {
    const h = make({ rows: rowsOf(), items: itemsOf(), subCustomer: "cus_2" });
    h.tx.auditLog.findFirst.mockResolvedValueOnce({ id: "already" });
    await h.completed();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled(); // still logged every time
  });

  describe("nothing is written BEFORE the customer check — not even the stale-downgrade bookkeeping", () => {
    /**
     * The flag-ON guard lets two shapes through (no customer on file; a stored customer equal to the
     * session's while the subscription's differs). With a newer DOWNGRADE snapshot the stale branch
     * used to write its audit row and email the tenant's admins before the customer was checked.
     */
    const staleWrites = (h: ReturnType<typeof make>) =>
      h.prisma.auditLog.create.mock.calls.filter(
        (c: any[]) => c[0]?.data?.action === "STRIPE_CHECKOUT_PLAN_SKIPPED_STALE",
      );

    it.each([
      [
        "a forged session (the session's customer is not the stored one)",
        { subCustomer: "cus_attacker" },
        { customer: "cus_attacker" },
      ],
      ["no customer on file for the tenant", { storedCustomer: null }, {}],
      [
        "the stored customer equals the session's but the SUBSCRIPTION's differs",
        { subCustomer: "cus_2" },
        {},
      ],
    ] as const)(
      "flag ON + a newer DOWNGRADE + %s: no STALE row, no email, resolves",
      async (_n, opts, extra) => {
        const h = make({
          flagOn: true,
          newerDowngrade: true,
          rows: rowsOf(),
          items: itemsOf(),
          ...opts,
        });

        await expect(h.completed(h.session({ ...extra }))).resolves.toBeUndefined();

        expect(staleWrites(h)).toEqual([]);
        expect(h.billingNotification.notifyCheckoutPlanNotApplied).not.toHaveBeenCalled();
        expectUntouched(h);
      },
    );

    it("control: a VERIFIED stale checkout still records the STALE row and tells the admins (the branch is unchanged)", async () => {
      const h = make({ flagOn: true, newerDowngrade: true, rows: rowsOf(), items: itemsOf() });
      await h.completed();
      expect(staleWrites(h)).toHaveLength(1);
      expect(h.billingNotification.notifyCheckoutPlanNotApplied).toHaveBeenCalledTimes(1);
    });
  });

  describe("a refusal says whether Stripe has already CHARGED for the subscription", () => {
    const trailOf = (h: ReturnType<typeof make>) =>
      h.tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data.meta)[0];

    it.each([
      ["active", true],
      ["trialing", true],
      ["incomplete", false],
      ["past_due", false],
      ["canceled", false],
    ] as const)("subscription status %s -> chargedButNotRecorded %s", async (status, charged) => {
      const h = make({ rows: rowsOf(), items: itemsOf(), subCustomer: "cus_2", subStatus: status });
      await h.completed();
      expect(trailOf(h)).toMatchObject({
        chargedButNotRecorded: charged,
        subscriptionStatus: status,
      });
      expect(errorLog.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        charged ? "CHARGED but not recorded" : "not charged",
      );
    });

    it("the flag-ON refusals carry it too (unknown tenant)", async () => {
      const h = make({ flagOn: true, rows: rowsOf(), items: itemsOf() });
      h.prisma.tenant.findUnique.mockResolvedValue(null);
      await h.completed();
      expect(trailOf(h)).toMatchObject({ reason: "unknown_tenant", chargedButNotRecorded: true });
    });
  });

  it("a verified checkout is untouched by the gate (stored = session = subscription customer)", async () => {
    const h = make({ rows: rowsOf(), items: itemsOf() });
    await h.completed();
    expect(h.rows.map((r) => r.stripeItemId)).toEqual(["si_pack", "si_fc"]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("NIT: a session with no subscription id (or no tenant metadata) resolves quietly: nothing retrieved, nothing written", async () => {
    const h = make({ rows: rowsOf(), items: itemsOf() });
    await expect(h.completed(h.session({ subscription: null }))).resolves.toBeUndefined();
    await expect(
      h.completed(h.session({ metadata: { planKey: "STARTER" } })),
    ).resolves.toBeUndefined();
    expect(h.stripe.getSubscription).not.toHaveBeenCalled();
    expectUntouched(h);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("SA-690 all three callers of createCheckoutSession bill the add-ons", () => {
  /** The three entry points, each over the SAME real BillingService (the checkout logic lives there). */
  const callers = (h: ReturnType<typeof make>) => ({
    // the tenant's own checkout (settings→billing): always monthly, takes no interval
    settings: () =>
      new SettingsBillingController(
        { getSubscription: jest.fn().mockResolvedValue({ planKey: "STARTER" }) } as any,
        {} as any,
        {} as any,
        h.billing,
      ).createCheckout({ tenantId: "t1", sub: "u1" } as any),
    // POST /billing/checkout (super-admin): takes URLs only, so always monthly
    billingController: () =>
      new BillingController(h.billing, {} as any).createCheckout({ tenantId: "t1" } as any),
    // the platform-admin link: the ONLY caller that can ask for an annual checkout
    adminLink: (interval?: "month" | "year") =>
      new PlatformAdminController(
        {} as any,
        {} as any,
        h.billing,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      ).createCheckout("t1", interval),
  });

  it.each([
    ["settings→billing (the tenant's own)", "settings"],
    ["POST /billing/checkout", "billingController"],
    ["platform-admin link (monthly)", "adminLink"],
  ] as const)("%s: one plan line + one line per unbilled add-on", async (_name, which) => {
    const h = make({ rows: [addonRow("CUSTOMER_PACK_100", { qty: 2 })] });

    await callers(h)[which]();

    const args = h.client.checkout.sessions.create.mock.calls[0][0];
    expect(args.line_items).toHaveLength(2);
    expect(args.line_items[1]).toMatchObject({
      price_data: { unit_amount: 5000, recurring: { interval: "month" } },
      quantity: 2,
    });
    expect(args.metadata).toMatchObject({ interval: "month", addonSkus: "CUSTOMER_PACK_100" });
  });

  it("the platform-admin link asked for ANNUAL is refused (409 ADDON_ANNUAL_NOT_SUPPORTED), nothing created in Stripe", async () => {
    const h = make({ rows: [addonRow("FORECASTING")] });

    const err: any = await callers(h)
      .adminLink("year")
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED });
    expect(h.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(h.stripe.createCustomer).not.toHaveBeenCalled();
  });

  it("the other two callers cannot ask for annual: they always send a monthly session", async () => {
    for (const which of ["settings", "billingController"] as const) {
      const h = make({ rows: [addonRow("FORECASTING")] });
      await callers(h)[which]();
      expect(h.client.checkout.sessions.create.mock.calls[0][0].metadata.interval).toBe("month");
    }
  });

  it.each([
    ["settings→billing", "settings"],
    ["POST /billing/checkout", "billingController"],
    ["platform-admin link", "adminLink"],
  ] as const)("%s: a tenant with no add-on still gets exactly the plan line", async (_n, which) => {
    const h = make({ rows: [] });
    await callers(h)[which]();
    expect(h.client.checkout.sessions.create.mock.calls[0][0].line_items).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("OPEN QUESTION (SA ruling): admin-granted self-serve add-ons on a trial", () => {
  /**
   * TenantAddon has NO field marking a platform-admin grant (no source / grantedBy / comp) and
   * AddonService.enableAddon leaves no per-row trace, so the checkout cannot tell a "free comp" from
   * a self-serve enable. These specs DOCUMENT what happens today; they are named so the ruling can
   * flip them (a free-comp discriminator needs a column + migration the owner/SA has not ruled on).
   *
   * What the admin path actually writes (addon.service.ts enableAddon, no stripePriceId, as on a trial
   * that has no Stripe subscription): { addonKey: <as typed>, sku: null unless the key is a bridged
   * legacy one, quantity: 1, priceSnapshot: 0, stripePriceId: null, stripeItemId: null }.
   */
  it("PENDING-SA-RULING (free comp): an admin-granted self-serve SKU on a trial whose row carries the SKU is BILLED at checkout", async () => {
    const granted = addonRow("FORECASTING", { qty: 1, priceSnapshot: 0 }); // sku set, no item, price 0
    const h = make({ status: "TRIAL", rows: [granted] });

    await h.billing.createCheckoutSession("t1", "month");

    const lines = h.client.checkout.sessions.create.mock.calls[0][0].line_items;
    expect(lines).toHaveLength(2);
    expect(lines[1].price_data.product_data.metadata).toEqual({ addonSku: "FORECASTING" });
  });

  it("PENDING-SA-RULING (free comp): the row the admin path writes for an UNPRICED FORECASTING grant has sku null and is NOT billed (invisible to the checkout)", async () => {
    const granted = { ...addonRow("FORECASTING"), sku: null }; // addonKey only
    const h = make({ status: "TRIAL", rows: [granted] });

    await h.billing.createCheckoutSession("t1", "month");

    expect(h.client.checkout.sessions.create.mock.calls[0][0].line_items).toHaveLength(1);
  });

  it("PENDING-SA-RULING (free comp): and at completion an admin-granted row that carries the SKU is adopted like any self-serve row", async () => {
    const h = make({
      status: "TRIAL",
      rows: [addonRow("FORECASTING", { qty: 1, priceSnapshot: 0 })],
      items: [baseItem(), checkoutItem("si_fc", "FORECASTING", 1900, 1)],
    });
    await h.completed();
    expect(h.rows[0]).toMatchObject({ stripeItemId: "si_fc", priceSnapshot: 19 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("ensureStripeCustomer is serialized per tenant (the billing advisory lock, never an in-process one)", () => {
  it("two concurrent checkouts for a tenant with no customer create ONE Stripe customer, and both sessions use it", async () => {
    const h = make({ rows: [], storedCustomer: null });

    await Promise.all([
      h.billing.createCheckoutSession("t1", "month"),
      h.billing.createCheckoutSession("t1", "month"),
    ]);

    expect(h.stripe.createCustomer).toHaveBeenCalledTimes(1);
    const customers = h.client.checkout.sessions.create.mock.calls.map((c: any[]) => c[0].customer);
    expect(customers).toEqual(["cus_new1", "cus_new1"]);
    expect(h.sub.stripeCustomerId).toBe("cus_new1");
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "billing", key: "customer:t1" }),
      expect.any(Function),
    );
  });

  it("a tenant that already has a customer takes no lock and creates nothing", async () => {
    const h = make({ rows: [] });
    await h.billing.ensureStripeCustomer("t1");
    expect(h.stripe.createCustomer).not.toHaveBeenCalled();
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
  });

  it("a lock that cannot be had is a 503 and creates nothing", async () => {
    const h = make({ rows: [], storedCustomer: null });
    mockWithAdvisoryLock.mockRejectedValueOnce(new MockLockTimeoutError("lock_timeout"));
    await expect(h.billing.ensureStripeCustomer("t1")).rejects.toMatchObject({ status: 503 });
    expect(h.stripe.createCustomer).not.toHaveBeenCalled();
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
