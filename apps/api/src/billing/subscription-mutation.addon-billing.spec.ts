/**
 * Self-serve add-on billing (owner ruling 2026-10-03): turning an add-on ON from
 * settings/billing puts it on the tenant's Stripe subscription as a prorated item (the platform-admin
 * path, `AddonService`, already does this when given a price); turning it OFF removes the item.
 *
 * Stripe is mocked at the module boundary (`StripeService`) — no live Stripe. Cases:
 *  1 enable creates exactly one Stripe item (inline price_data, create_prorations)
 *  2 repeat / concurrent enable never creates a second item
 *  3 disable removes the item (and tolerates an already-gone item)
 *  4 a failing Stripe call never leaves the row enabled / the ledger booked, fixed-copy 503
 *  5 a tenant with NO Stripe subscription (pilot) or Stripe not configured stays free + unbooked
 *  6 tenant isolation, 7 ledger only after Stripe succeeds, 8 nothing retro-bills
 *  M manually-invoiced (externalPayment) tenants: ON at catalog price, revenue booked, no Stripe,
 *    one platform notice (owner ruling 2026-10-03)
 *  B2/B3 Stripe API shape of the prorated item; refusing a quantity raise on an unbilled legacy row
 */
const lockQueues = new Map<string, Promise<unknown>>();
const mockWithAdvisoryLock = jest.fn(async (opts: { key: string }, fn: () => Promise<unknown>) => {
  const prior = lockQueues.get(opts.key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((res) => {
    release = res;
  });
  lockQueues.set(
    opts.key,
    prior.then(() => done),
  );
  await prior;
  try {
    const value = await fn();
    return { acquired: true as const, value };
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

import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { API_ERROR_CODES } from "../common/api-error-codes";

const CATALOG = {
  addonSkus: [
    { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12 },
    { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25, includedAtPlan: "SCALE" },
    { sku: "MSRP", name: "MSRP", monthlyPrice: 20 },
  ],
  definitions: [],
};

const MANUAL_SUB = {
  tenantId: "t1",
  stripeSubId: null,
  stripeCustomerId: null,
  billingInterval: null,
  cycle: "MONTHLY",
  externalPayment: true,
};

const ACTIVE_SUB = {
  tenantId: "t1",
  stripeSubId: "sub_t1",
  stripeCustomerId: "cus_t1",
  billingInterval: "month",
  cycle: "MONTHLY",
};

interface Opts {
  sub?: Record<string, unknown> | null;
  addonRow?: Record<string, unknown> | null;
  stripeConfigured?: boolean;
  createFails?: unknown;
  /** Stripe CREATES the item but the response is lost (timeout): the caller sees an error, the item exists. */
  createTimesOutAfterCreating?: boolean;
  delFails?: unknown;
  updateFails?: unknown;
  txFails?: boolean;
  stripeProrationCents?: number | null;
  /** The pending proration lines Stripe ADDS when the (first) item change happens (real-shape items). */
  invoiceItems?: any[];
  /** Pending proration lines that already exist BEFORE the call (an earlier change, still unbilled). */
  priorInvoiceItems?: any[];
  /** What Stripe adds per item change, for a test that makes several (n = 1, 2, ...). Overrides `invoiceItems`. */
  stripeLines?: (call: { n: number; itemId: string; quantity: number }) => any[];
  stripeTenantSubFor?: string;
  /** TenantSubscription.planKey (the tenant's current plan); undefined leaves the fixture's own. */
  planKey?: string | null;
  /** The legacy Tenant.plan enum, the fallback when the subscription carries no planKey. */
  tenantPlan?: string;
}

const NOW_S = () => Math.floor(Date.now() / 1000);

/**
 * A pending proration InvoiceItem exactly as the sandbox returns it under the pinned API version
 * 2026-08-26.dahlia (`stripe invoiceitems list`, captured 2026-10-04, test mode, no secrets): there
 * is NO `created` field on the object, its creation time is `date`, and the subscription item it
 * belongs to is `parent.subscription_details.subscription_item`. (The list REQUEST param is still
 * called `created`.) Never rebuild this with `created` — that is how F1 hid: the old fixture
 * carried a field the real object does not have.
 */
let iiSeq = 0;
function prorationItem(o: {
  amount: number;
  date?: number;
  item?: string;
  proration?: boolean;
  id?: string;
}) {
  return {
    id: o.id ?? `ii_1UN35e${String(++iiSeq).padStart(6, "0")}`,
    object: "invoiceitem",
    amount: o.amount,
    currency: "usd",
    customer: "cus_t1",
    customer_account: null,
    date: o.date ?? NOW_S(),
    description: "Unused time on 2 × RouteFlow add-on — Customer pack (+100) after 05 Oct 2026",
    discountable: false,
    discounts: [],
    frozen_fields: ["pricing", "quantity", "discounts"],
    invoice: null,
    invoicing_rules: [],
    livemode: false,
    metadata: {},
    net_amount: o.amount,
    parent: {
      subscription_details: {
        subscription: "sub_t1",
        subscription_item: o.item ?? "si_1",
      },
      type: "subscription_details",
    },
    period: { end: 1793851237, start: 1791172886 },
    pricing: {
      price_details: { price: "price_1UN34eB7KzYEvmBqW0qTkLv5", product: "prod_VNoiOBesncBnYg" },
      type: "price_details",
      unit_amount_decimal: null,
    },
    proration: o.proration ?? true,
    proration_details: {
      credited_items: { invoice_item: "ii_1UN34xB7KzYEvmBq6wrDOJ5f", type: "invoice_item" },
      discount_amounts: [],
    },
    quantity: 2,
    quantity_decimal: "2",
    tax_rates: [],
    test_clock: null,
  };
}

function make(opts: Opts = {}) {
  // The subscription's items as Stripe holds them, so a lost response leaves a REAL orphan.
  const stripeItems: any[] = [];
  let itemSeq = 0;
  // The customer's PENDING proration invoice items, as Stripe holds them: lines that existed before the
  // call, plus whatever each item change adds. `readStripeProration` takes a before/after diff by id, so
  // a line from an earlier change can never leak into a later call's figure, however close in time.
  const defaultLines = () =>
    opts.stripeProrationCents == null
      ? []
      : [
          prorationItem({ amount: opts.stripeProrationCents }),
          prorationItem({ amount: 99999, item: "si_OTHER" }), // another item
          prorationItem({ amount: 55555, proration: false }), // not a proration line of ours
        ];
  const pending: any[] = [
    ...(opts.priorInvoiceItems ??
      (opts.stripeProrationCents == null || opts.invoiceItems
        ? []
        : // on an item that ALREADY exists, an OLDER proration line (an earlier quantity change): not ours.
          // (A brand-new item has no earlier lines.)
          opts.addonRow?.stripeItemId
          ? [
              prorationItem({
                amount: 7777,
                date: NOW_S() - 86400,
                item: String(opts.addonRow.stripeItemId),
              }),
            ]
          : [])),
  ];
  let changeNo = 0;
  const stripeAddsLines = (itemId: string, quantity: number) => {
    changeNo += 1;
    pending.push(
      ...(opts.stripeLines
        ? opts.stripeLines({ n: changeNo, itemId, quantity })
        : changeNo === 1
          ? (opts.invoiceItems ?? defaultLines())
          : []),
    );
  };
  const stripeClient = {
    products: { create: jest.fn().mockResolvedValue({ id: "prod_1" }) },
    subscriptionItems: {
      create: opts.createFails
        ? jest.fn().mockRejectedValue(opts.createFails)
        : jest.fn(async (args: any) => {
            const item = {
              id: `si_${++itemSeq}`,
              metadata: args.metadata,
              quantity: args.quantity,
              subscription: args.subscription,
            };
            stripeItems.push(item);
            stripeAddsLines(item.id, args.quantity);
            if (opts.createTimesOutAfterCreating) throw new Error("ETIMEDOUT");
            return item;
          }),
      list: jest.fn(async ({ subscription }: any) => ({
        data: stripeItems.filter((i) => i.subscription === subscription),
      })),
      update: opts.updateFails
        ? jest.fn().mockRejectedValue(opts.updateFails)
        : jest.fn(async (id: string, args: any) => {
            stripeAddsLines(id, args?.quantity);
            return { id };
          }),
      del: opts.delFails
        ? jest.fn().mockRejectedValue(opts.delFails)
        : jest.fn(async (id: string) => {
            const i = stripeItems.findIndex((x) => x.id === id);
            if (i >= 0) stripeItems.splice(i, 1);
            return {};
          }),
    },
    invoiceItems: { list: jest.fn(async () => ({ data: [...pending] })) },
  };
  const stripe = {
    isConfigured: opts.stripeConfigured ?? true,
    client: stripeClient,
  } as any;

  // A stateful add-on row so a second serialised call observes the first call's write.
  let row: any = opts.addonRow === undefined ? null : opts.addonRow && { ...opts.addonRow };
  const tenantAddon = {
    findFirst: jest.fn(async () => (row ? { ...row } : null)),
    findUnique: jest.fn(async () => (row ? { ...row } : null)),
    upsert: jest.fn(async ({ create, update }: any) => {
      row = row
        ? { ...row, ...update, id: row.id ?? "a1" }
        : { id: "a1", addonKey: create.addonKey, ...create };
      return { ...row };
    }),
    update: jest.fn(async ({ data }: any) => {
      row = { ...row, ...data };
      return { ...row };
    }),
    // "is this Stripe item already referenced by one of the tenant's rows?" (orphan adoption)
    findMany: jest.fn(async ({ where }: any) =>
      row && where?.stripeItemId?.in?.includes(row.stripeItemId) ? [{ ...row }] : [],
    ),
  };
  const tx = {
    tenantAddon,
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "TEAM" },
      }),
    },
  };
  const prisma = {
    tenantAddon,
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        slug: "acme",
        name: "Acme Foods",
        plan: opts.tenantPlan ?? "STARTER",
      }),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(
        (() => {
          const subRow = opts.sub === undefined ? ACTIVE_SUB : opts.sub;
          return subRow && opts.planKey !== undefined
            ? { ...subRow, planKey: opts.planKey }
            : subRow;
        })(),
      ),
    },
    $transaction: jest.fn(async (fn: any) => {
      if (opts.txFails) throw new Error("db down: internal detail");
      return fn(tx);
    }),
  } as any;
  const cat = { getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG) } as any;
  const proration = {
    prorationPreview: jest.fn().mockResolvedValue({ proratedToday: 6.4 }),
  } as any;
  const subscription = { getSubscription: jest.fn().mockResolvedValue({ planKey: "TEAM" }) } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const svc = new SubscriptionMutationService(
    prisma,
    cat,
    proration,
    subscription,
    entitlements,
    events,
    { invalidate: jest.fn() } as any,
    stripe,
    { notifyUpgradeConfirmed: jest.fn(), notifyDowngradeScheduled: jest.fn() } as any,
    { prepare: jest.fn(), onPlanChange: jest.fn() } as any,
  );
  return {
    svc,
    prisma,
    tx,
    tenantAddon,
    stripeClient,
    stripeItems,
    events,
    entitlements,
    getRow: () => row,
  };
}

const enabledDeltas = (events: any) =>
  events.emit.mock.calls
    .filter((c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED)
    .map((c: any[]) => c[3]?.amountDelta);

describe("self-serve enableAddon — billed through Stripe", () => {
  it("1: creates exactly ONE Stripe item, inline price_data, quantity, explicit create_prorations", async () => {
    const { svc, stripeClient, tenantAddon, events } = make();

    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");

    expect(stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    const args = stripeClient.subscriptionItems.create.mock.calls[0][0];
    expect(args).toMatchObject({
      subscription: "sub_t1",
      quantity: 1,
      proration_behavior: "create_prorations",
      price_data: {
        currency: "usd",
        unit_amount: 1200,
        recurring: { interval: "month" },
        product: "prod_1",
      },
    });
    expect(tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ stripeItemId: "si_1", priceSnapshot: 12 }),
      }),
    );
    expect(enabledDeltas(events)).toEqual([12]);
  });

  it("1b: quantity > 1 is sent to Stripe and priced per unit", async () => {
    const { svc, stripeClient } = make();
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(stripeClient.subscriptionItems.create.mock.calls[0][0]).toMatchObject({
      quantity: 3,
      price_data: { unit_amount: 1200 },
    });
  });

  it("2: a repeat enable of an already-billed add-on creates NO second Stripe item and books nothing", async () => {
    const { svc, stripeClient, events } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: "si_1",
      },
    });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.update).not.toHaveBeenCalled();
    expect(enabledDeltas(events)).toEqual([]);
  });

  it("2b: two CONCURRENT enables create exactly one Stripe item and book the ledger once", async () => {
    const { svc, stripeClient, events } = make();
    const [a, b] = await Promise.allSettled([
      svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1"),
      svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1"),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(enabledDeltas(events)).toEqual([12]);
  });

  it("2c: a re-enable of an already-billed add-on at a NEW quantity updates the item (prorated), never creates one", async () => {
    const { svc, stripeClient, events } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: "si_1",
      },
    });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.update).toHaveBeenCalledWith("si_1", {
      quantity: 2,
      proration_behavior: "create_prorations",
    });
    expect(enabledDeltas(events)).toEqual([12]); // 12 x (2 - 1)
  });

  it("2d: the response carries what STRIPE prorated (authoritative), not the local estimate", async () => {
    const { svc, stripeClient } = make({ stripeProrationCents: 637 });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(res.billing).toBe("STRIPE");
    expect(res.proratedNow).toBe(6.37); // not the 6.4 estimate
    // only the invoice items of THIS subscription item are summed
    expect(stripeClient.invoiceItems.list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_t1", pending: true }),
    );
  });

  it("2e: if Stripe's proration can't be read the add-on is still enabled and proratedNow is null (never the estimate)", async () => {
    const { svc } = make({ stripeProrationCents: null });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(res.billing).toBe("STRIPE");
    expect(res.proratedNow).toBeNull();
  });

  it("3: a failed Stripe create leaves NO enabled row, books NOTHING, and shows fixed copy", async () => {
    const { svc, getRow, events, entitlements } = make({
      createFails: new Error("card_declined: sk_live_internal"),
    });
    const err: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(String(err.message)).not.toMatch(/sk_live|card_declined|t1|CUSTOMER_PACK/);
    expect(getRow()).toBeNull();
    expect(events.emit).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("3b: Stripe succeeds but the DB write fails -> the just-created item is removed, nothing booked", async () => {
    const { svc, stripeClient, events } = make({ txFails: true });
    await expect(svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1")).rejects.toBeDefined();
    expect(stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_1");
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("3c: an annual Stripe subscription can't carry a monthly item -> refused with fixed copy, no Stripe call", async () => {
    const { svc, stripeClient, getRow } = make({
      sub: { ...ACTIVE_SUB, billingInterval: "year", cycle: "ANNUAL" },
    });
    const err: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(ANNUAL_REFUSAL);
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(getRow()).toBeNull();
  });
});

describe("self-serve disableAddon — removes the Stripe item", () => {
  const billedRow = {
    id: "a1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    active: true,
    quantity: 1,
    priceSnapshot: 12,
    stripeItemId: "si_1",
  };

  it("4: deletes the item (prorated credit), then deactivates the row and clears the pointer", async () => {
    const { svc, stripeClient, getRow, events } = make({ addonRow: billedRow });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_1", {
      proration_behavior: "create_prorations",
    });
    expect(getRow()).toMatchObject({ active: false, stripeItemId: null });
    const disabled = events.emit.mock.calls.filter(
      (c: any[]) => c[1] === BILLING_EVENTS.ADDON_DISABLED,
    );
    expect(disabled.map((c: any[]) => c[3]?.amountDelta)).toEqual([-12]);
  });

  it("4b: an item Stripe already deleted (resource_missing) counts as removed", async () => {
    const { svc, getRow } = make({
      addonRow: billedRow,
      delFails: Object.assign(new Error("No such subscription item"), { code: "resource_missing" }),
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(getRow()).toMatchObject({ active: false, stripeItemId: null });
  });

  it("4c: any OTHER Stripe failure keeps the add-on enabled (we never keep billing silently), fixed copy", async () => {
    const { svc, getRow, events } = make({
      addonRow: billedRow,
      delFails: new Error("api_connection_error: internal"),
    });
    const err: any = await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(String(err.message)).not.toMatch(/api_connection|internal|si_1/);
    expect(getRow()).toMatchObject({ active: true, stripeItemId: "si_1" });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("self-serve add-on for tenants that are not billed through Stripe", () => {
  it("5: a pilot with NO stripeSubId stays free: no Stripe call, add-on on, priced 0, NO revenue booked", async () => {
    const { svc, stripeClient, tenantAddon, events, tx } = make({
      sub: { ...ACTIVE_SUB, stripeSubId: null },
    });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.products.create).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ active: true, priceSnapshot: 0 }),
      }),
    );
    expect(enabledDeltas(events)).toEqual([]); // case 15: never count revenue we don't bill
    expect(res.billing).toBe("UNBILLED");
    expect(res.proratedNow).toBe(0);
    expect(tx.auditLog.create).not.toHaveBeenCalled(); // nothing to invoice, nothing to tell the owner
  });

  it("5b: a tenant with no subscription row at all is treated the same (free, unbooked)", async () => {
    const { svc, stripeClient, events } = make({ sub: null });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(enabledDeltas(events)).toEqual([]);
  });

  it("5c: Stripe not configured -> free and unbooked, never throws", async () => {
    const { svc, stripeClient, events } = make({ stripeConfigured: false });
    await expect(svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1")).resolves.toBeDefined();
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(enabledDeltas(events)).toEqual([]);
  });

  it("SA F1: disabling an add-on WITH a stripeItemId while Stripe is NOT configured is refused and KEEPS the handle", async () => {
    const { svc, stripeClient, getRow, events } = make({
      stripeConfigured: false,
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: "si_live",
      },
    });
    const err: any = await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(String(err.message)).not.toMatch(/si_live|Stripe/);
    expect(stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ active: true, stripeItemId: "si_live" }); // handle kept
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("5d: disabling an unbilled add-on (no stripeItemId) never calls Stripe", async () => {
    const { svc, stripeClient, getRow } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 0,
        stripeItemId: null,
      },
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ active: false });
  });

  it("addonBillingMode tells the preview how the tenant is billed: STRIPE | MANUAL | UNBILLED", async () => {
    expect(await make().svc.addonBillingMode("t1")).toBe("STRIPE");
    expect(await make({ sub: MANUAL_SUB }).svc.addonBillingMode("t1")).toBe("MANUAL");
    // N1: externalPayment is never cleared, so a tenant that was manually activated and LATER pays by
    // card (stripeSubId set) is STRIPE — stripeSubId is checked first.
    expect(
      await make({ sub: { ...ACTIVE_SUB, externalPayment: true } }).svc.addonBillingMode("t1"),
    ).toBe("STRIPE");
    expect(
      await make({ sub: { ...ACTIVE_SUB, stripeSubId: null } }).svc.addonBillingMode("t1"),
    ).toBe("UNBILLED");
    expect(await make({ sub: null }).svc.addonBillingMode("t1")).toBe("UNBILLED");
    expect(await make({ stripeConfigured: false }).svc.addonBillingMode("t1")).toBe("UNBILLED");
    expect(
      await make({ stripeConfigured: false, sub: MANUAL_SUB }).svc.addonBillingMode("t1"),
    ).toBe("MANUAL");
  });
});

describe("self-serve add-on billing — isolation, retro-billing, gates", () => {
  it("6: the Stripe item goes on THIS tenant's own subscription (isolation)", async () => {
    const { svc, stripeClient, prisma } = make({
      sub: { ...ACTIVE_SUB, tenantId: "tA", stripeSubId: "sub_A", stripeCustomerId: "cus_A" },
    });
    await svc.enableAddon("tA", "CUSTOMER_PACK_100", 1, "u1");
    expect(prisma.tenantSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tA" } }),
    );
    expect(stripeClient.subscriptionItems.create.mock.calls[0][0].subscription).toBe("sub_A");
    expect(stripeClient.subscriptionItems.create.mock.calls[0][0].metadata).toMatchObject({
      tenantId: "tA",
    });
  });

  it("7: the MRR ledger event fires only AFTER the Stripe create succeeded", async () => {
    const order: string[] = [];
    const m = make();
    m.stripeClient.subscriptionItems.create.mockImplementation(async () => {
      order.push("stripe");
      return { id: "si_1" };
    });
    m.events.emit.mockImplementation(async (_t: string, type: string) => {
      order.push(`event:${type}`);
      return {};
    });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(order.indexOf("stripe")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("stripe")).toBeLessThan(
      order.indexOf(`event:${BILLING_EVENTS.ADDON_ENABLED}`),
    );
  });

  it("8: an add-on that was ALREADY active and unbilled is not retro-billed by a re-enable at the same qty", async () => {
    const { svc, stripeClient, tenantAddon } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12, // legacy row: catalog snapshot, no Stripe item
        stripeItemId: null,
      },
    });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).not.toHaveBeenCalled();
  });

  it("8b: nothing in a read path bills: getting the preview flag touches no Stripe write", async () => {
    const { svc, stripeClient } = make();
    await svc.addonBillingMode("t1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.update).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it("9: the self-service gate is unchanged: an admin-only SKU is refused before any Stripe call", async () => {
    const { svc, stripeClient } = make();
    await expect(svc.enableAddon("t1", "MSRP", 1, "u1")).rejects.toMatchObject({ status: 403 });
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("10: the enable and the admin path share ONE lock key per (tenant, sku)", async () => {
    mockWithAdvisoryLock.mockClear();
    const { svc } = make();
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "billing", key: "addon:t1:CUSTOMER_PACK_100" }),
      expect.any(Function),
    );
  });
});

describe("manually-invoiced (externalPayment) tenants — owner ruling 2026-10-03", () => {
  it("M1: enable is ON at the CATALOG price, books the revenue, and makes NO Stripe call", async () => {
    const { svc, stripeClient, tenantAddon, events } = make({ sub: MANUAL_SUB });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");

    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.products.create).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ active: true, priceSnapshot: 12, quantity: 2 }),
      }),
    );
    expect(tenantAddon.upsert.mock.calls[0][0].create.stripeItemId ?? null).toBeNull();
    expect(enabledDeltas(events)).toEqual([24]); // 12 x 2, counted as revenue
    expect(res.billing).toBe("MANUAL");
    expect(res.proratedNow).toBeNull(); // the owner invoices it; no card amount exists
  });

  it("M2: exactly ONE platform notice, naming the add-on and the tenant, in the platform audit feed", async () => {
    const { svc, tx } = make({ sub: MANUAL_SUB });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: "t1",
      action: "ADDON_MANUAL_INVOICE_DUE",
      entityType: "tenant",
      entityId: "t1",
    });
    expect(data.meta).toMatchObject({
      platformAdmin: true,
      sku: "CUSTOMER_PACK_100",
      message: "Add-on Customer pack enabled for Acme Foods: add to their next manual invoice",
      addonName: "Customer pack",
      kind: "add",
      fromQty: 0,
      toQty: 1,
    });
  });

  it("a quantity RAISE on an existing manual row is kind 'change' (from -> to)", async () => {
    const { svc, tx } = make({
      sub: MANUAL_SUB,
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: null,
      },
    });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(tx.auditLog.create.mock.calls[0][0].data.meta).toMatchObject({
      kind: "change",
      fromQty: 1,
      toQty: 3,
    });
  });

  it("M3: a repeat enable raises no second notice and books nothing", async () => {
    const { svc, tx, events } = make({ sub: MANUAL_SUB });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(enabledDeltas(events)).toEqual([12]);
  });

  it("M4: disable reverses the booked revenue and never calls Stripe", async () => {
    const { svc, stripeClient, events, getRow } = make({
      sub: MANUAL_SUB,
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 2,
        priceSnapshot: 12,
        stripeItemId: null,
      },
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ active: false });
    const disabled = events.emit.mock.calls.filter(
      (c: any[]) => c[1] === BILLING_EVENTS.ADDON_DISABLED,
    );
    expect(disabled.map((c: any[]) => c[3]?.amountDelta)).toEqual([-24]);
  });

  it("M5: a Stripe-billed tenant raises NO manual-invoice notice", async () => {
    const { svc, tx } = make();
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("M6: Stripe not configured but externalPayment set is still MANUAL (no Stripe needed)", async () => {
    const { svc, events } = make({ sub: MANUAL_SUB, stripeConfigured: false });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(res.billing).toBe("MANUAL");
    expect(enabledDeltas(events)).toEqual([12]);
  });
});

describe("B3 — a quantity raise on an unbilled legacy row of a Stripe-billed tenant", () => {
  const legacy = {
    id: "a1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    active: true,
    quantity: 1,
    priceSnapshot: 12,
    stripeItemId: null,
  };

  it("B3: is refused with fixed copy: no Stripe charge, no MRR booked, row untouched", async () => {
    const { svc, stripeClient, events, tenantAddon, getRow } = make({ addonRow: legacy });
    const err: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 5, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(String(err.message)).toMatch(/contact support/i);
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ quantity: 1, stripeItemId: null });
  });

  it("B3b: a manually-invoiced tenant may still raise the quantity of its own row", async () => {
    const { svc, events } = make({ sub: MANUAL_SUB, addonRow: legacy });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(enabledDeltas(events)).toEqual([24]); // 12 x (3 - 1)
  });
});

describe("should-fix — idempotency key and disable under the enable lock", () => {
  it("every item create carries a per-attempt Stripe idempotency key; a retry after a failure gets a NEW key", async () => {
    const m = make({ txFails: true });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1").catch(() => undefined);
    const k1 = m.stripeClient.subscriptionItems.create.mock.calls[0][1]?.idempotencyKey;
    expect(k1).toMatch(/^addon-item:t1:CUSTOMER_PACK_100:/);
    // a second attempt (after the orphan was cleaned up) must not replay the deleted item
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1").catch(() => undefined);
    const k2 = m.stripeClient.subscriptionItems.create.mock.calls[1][1]?.idempotencyKey;
    expect(k2).toMatch(/^addon-item:t1:CUSTOMER_PACK_100:/);
    expect(k2).not.toBe(k1);
  });

  it("disableAddon takes the SAME addon:<tenant>:<sku> lock as enable", async () => {
    mockWithAdvisoryLock.mockClear();
    const { svc } = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: "si_1",
      },
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "billing", key: "addon:t1:CUSTOMER_PACK_100" }),
      expect.any(Function),
    );
  });

  it("an enable and a disable of the same add-on never interleave (serialised on one key)", async () => {
    const m = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: "si_1",
      },
    });
    await Promise.all([
      m.svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1"),
      m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1"),
    ]);
    // disable ran first (deleted si_1, row off); the serialised enable then saw an INACTIVE row
    // and created exactly one fresh item: the tenant ends with one item, not two.
    expect(m.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(m.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(m.getRow()).toMatchObject({ active: true, stripeItemId: "si_1" });
  });
});

describe("N1 — a manually-activated tenant that later pays by card is STRIPE", () => {
  const BOTH = { ...ACTIVE_SUB, externalPayment: true };

  it("N1: creates the Stripe item, books once, no manual notice", async () => {
    const { svc, stripeClient, tx, events } = make({ sub: BOTH });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(res.billing).toBe("STRIPE");
    expect(stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(enabledDeltas(events)).toEqual([12]);
  });
});

describe("N2 — manual tenant: re-price only on an increase; a decrease reverses at the row's own price", () => {
  const row = (quantity: number, priceSnapshot: number) => ({
    id: "a1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    active: true,
    quantity,
    priceSnapshot,
    stripeItemId: null,
  });
  const disabledDeltas = (events: any) =>
    events.emit.mock.calls
      .filter((c: any[]) => c[1] === BILLING_EVENTS.ADDON_DISABLED)
      .map((c: any[]) => c[3]?.amountDelta);

  it("N2: lowering a $0 row 3 -> 2 books NOTHING (it must not re-price to catalog)", async () => {
    const { svc, events, getRow } = make({ sub: MANUAL_SUB, addonRow: row(3, 0) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(enabledDeltas(events)).toEqual([]);
    expect(disabledDeltas(events)).toEqual([]);
    expect(getRow()).toMatchObject({ quantity: 2, priceSnapshot: 0 });
  });

  it("N2: lowering a priced row 3 -> 2 reverses ONE unit at the row's own price", async () => {
    const { svc, events } = make({ sub: MANUAL_SUB, addonRow: row(3, 9) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(disabledDeltas(events)).toEqual([-9]); // 9 x (2 - 3), not catalog 12
  });

  it("N2: raising a $0 row 1 -> 2 re-prices it to the catalog price", async () => {
    const { svc, events } = make({ sub: MANUAL_SUB, addonRow: row(1, 0) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(enabledDeltas(events)).toEqual([24]);
  });

  it("(c) a decrease on a priced manual row raises a 'reduce to N' platform notice", async () => {
    const { svc, tx } = make({ sub: MANUAL_SUB, addonRow: row(3, 12) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const d = tx.auditLog.create.mock.calls[0][0].data;
    expect(d.action).toBe("ADDON_MANUAL_INVOICE_STOP");
    expect(d.meta.message).toBe(
      "Add-on Customer pack reduced to 2 for Acme Foods: reduce their next manual invoice to 2",
    );
    expect(d.meta).toMatchObject({
      addonName: "Customer pack",
      kind: "change",
      fromQty: 3,
      toQty: 2,
    });
  });

  it("(c) a decrease on a $0 manual row raises NO notice (nothing was being invoiced)", async () => {
    const { svc, tx } = make({ sub: MANUAL_SUB, addonRow: row(3, 0) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("G2 — an UNBILLED tenant's quantity change on a legacy non-zero row books no revenue", () => {
  const legacy = (quantity: number) => ({
    id: "a1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    active: true,
    quantity,
    priceSnapshot: 12,
    stripeItemId: null,
  });
  const PILOT = { ...ACTIVE_SUB, stripeSubId: null };
  const bookedDeltas = (events: any) =>
    events.emit.mock.calls
      .filter((c: any[]) =>
        [BILLING_EVENTS.ADDON_ENABLED, BILLING_EVENTS.ADDON_DISABLED].includes(c[1]),
      )
      .map((c: any[]) => c[3]?.amountDelta);

  it("G2: raising 1 -> 3 stores snapshot 0 and never books a POSITIVE delta (the old revenue is reversed)", async () => {
    const { svc, getRow, events, stripeClient } = make({ sub: PILOT, addonRow: legacy(1) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ quantity: 3, priceSnapshot: 0 });
    // 0 x 3 - 12 x 1: unbilled revenue withdrawn, none added (the event type follows the QUANTITY
    // direction, so a quantity raise is typed ADDON_ENABLED even though its amount is negative).
    expect(bookedDeltas(events)).toEqual([-12]);
    expect(bookedDeltas(events).every((d: number) => d <= 0)).toBe(true);
  });

  it("G2: lowering 3 -> 2 stores snapshot 0 as well (no re-pricing in either direction)", async () => {
    const { svc, getRow, events } = make({ sub: PILOT, addonRow: legacy(3) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(getRow()).toMatchObject({ quantity: 2, priceSnapshot: 0 });
    expect(bookedDeltas(events)).toEqual([-36]);
  });

  it("G2: Stripe not configured behaves the same (UNBILLED)", async () => {
    const { svc, getRow, events } = make({ stripeConfigured: false, addonRow: legacy(1) });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(getRow()).toMatchObject({ priceSnapshot: 0 });
    expect(enabledDeltas(events).every((d: number) => d <= 0)).toBe(true); // never a positive booking
  });
});

describe("(c) manual tenant disable raises a 'stop invoicing' platform notice", () => {
  const priced = {
    id: "a1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    active: true,
    quantity: 1,
    priceSnapshot: 12,
    stripeItemId: null,
  };

  it("disable: one notice naming the add-on and the tenant", async () => {
    const { svc, tx } = make({ sub: MANUAL_SUB, addonRow: priced });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const d = tx.auditLog.create.mock.calls[0][0].data;
    expect(d).toMatchObject({
      tenantId: "t1",
      action: "ADDON_MANUAL_INVOICE_STOP",
      entityType: "tenant",
    });
    expect(d.meta.message).toBe(
      "Add-on Customer pack turned off for Acme Foods: stop invoicing it",
    );
    expect(d.meta).toMatchObject({
      addonName: "Customer pack",
      kind: "stop",
      fromQty: 1,
      toQty: 0,
    });
  });

  it("a $0 row, a Stripe tenant and a pilot raise no notice", async () => {
    const zero = make({ sub: MANUAL_SUB, addonRow: { ...priced, priceSnapshot: 0 } });
    await zero.svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    const stripe = make({ addonRow: { ...priced, stripeItemId: "si_9" } });
    await stripe.svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    const pilot = make({ sub: { ...ACTIVE_SUB, stripeSubId: null }, addonRow: priced });
    await pilot.svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(zero.tx.auditLog.create).not.toHaveBeenCalled();
    expect(stripe.tx.auditLog.create).not.toHaveBeenCalled();
    expect(pilot.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("ORPHAN — Stripe created the item but the response was lost", () => {
  it("a timeout then a retry ends with exactly ONE item: the retry ADOPTS the orphan, never creates a second", async () => {
    const m = make({ createTimesOutAfterCreating: true });
    const first: any = await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1").catch((e) => e);
    expect(first).toBeInstanceOf(ServiceUnavailableException);
    expect(m.stripeItems).toHaveLength(1); // the orphan is really there
    expect(m.getRow()).toBeNull();

    m.stripeClient.subscriptionItems.create.mockClear();
    const res: any = await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");

    expect(m.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(m.stripeItems).toHaveLength(1);
    expect(m.getRow()).toMatchObject({ active: true, stripeItemId: m.stripeItems[0].id });
    expect(res.billing).toBe("STRIPE");
    expect(enabledDeltas(m.events)).toEqual([12]);
  });

  it("extra unreferenced matching items are deleted, one is adopted", async () => {
    const m = make();
    const meta = { tenantId: "t1", sku: "CUSTOMER_PACK_100" };
    m.stripeItems.push(
      { id: "si_a", metadata: meta, quantity: 1, subscription: "sub_t1" },
      { id: "si_b", metadata: meta, quantity: 1, subscription: "sub_t1" },
    );
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(m.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(m.stripeItems.map((i) => i.id)).toEqual(["si_a"]);
    expect(m.stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_b");
  });

  it("an adopted item whose quantity differs is brought to the requested quantity", async () => {
    const m = make();
    m.stripeItems.push({
      id: "si_a",
      metadata: { tenantId: "t1", sku: "CUSTOMER_PACK_100" },
      quantity: 1,
      subscription: "sub_t1",
    });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(m.stripeClient.subscriptionItems.update).toHaveBeenCalledWith("si_a", {
      quantity: 3,
      proration_behavior: "create_prorations",
    });
  });

  it("an item already referenced by the tenant's row, another tenant's item and another SKU are left alone", async () => {
    const m = make({
      addonRow: {
        id: "a1",
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        active: false,
        quantity: 1,
        priceSnapshot: 12,
        stripeItemId: "si_ref",
      },
    });
    m.stripeItems.push(
      {
        id: "si_ref",
        metadata: { tenantId: "t1", sku: "CUSTOMER_PACK_100" },
        subscription: "sub_t1",
      },
      {
        id: "si_other_tenant",
        metadata: { tenantId: "t9", sku: "CUSTOMER_PACK_100" },
        subscription: "sub_t1",
      },
      {
        id: "si_other_sku",
        metadata: { tenantId: "t1", sku: "FORECASTING" },
        subscription: "sub_t1",
      },
    );
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(m.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(m.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
  });

  it("if the subscription's items cannot be listed the enable is refused (fail closed), nothing created", async () => {
    const m = make();
    m.stripeClient.subscriptionItems.list.mockRejectedValueOnce(new Error("api_connection_error"));
    const err: any = await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(m.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(m.getRow()).toBeNull();
  });
});

// ─── #3129 sandbox-checklist folds (F1, F2/B1088, F3, preview agreement) ─────────────────────────

const ANNUAL_SUB = { ...ACTIVE_SUB, billingInterval: "year", cycle: "ANNUAL" };
const ANNUAL_COPY = "Add-ons can't be added to an annual plan online yet. Please contact support.";
const ANNUAL_REFUSAL = { code: API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED, message: ANNUAL_COPY };
const INCLUDED_REFUSAL = {
  code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN,
  message: "Forecasting is already included in your plan.",
};

const billedPack = (quantity: number) => ({
  id: "a1",
  addonKey: "CUSTOMER_PACK_100",
  sku: "CUSTOMER_PACK_100",
  active: true,
  quantity,
  priceSnapshot: 12,
  stripeItemId: "si_1",
});

/** Nothing reached Stripe, the database or the MRR ledger. */
function expectUntouched(m: ReturnType<typeof make>) {
  expect(m.stripeClient.products.create).not.toHaveBeenCalled();
  expect(m.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  expect(m.stripeClient.subscriptionItems.update).not.toHaveBeenCalled();
  expect(m.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
  expect(m.prisma.$transaction).not.toHaveBeenCalled();
  expect(m.tenantAddon.upsert).not.toHaveBeenCalled();
  expect(m.events.emit).not.toHaveBeenCalled();
  expect(m.entitlements.invalidate).not.toHaveBeenCalled();
}

const rejection = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => undefined,
    (e) => e,
  );

describe("F1: Stripe's proration is read from the InvoiceItem `date` (2026-08-26.dahlia has no `created`)", () => {
  it("pins the fixture to the real object: `date`, no `created`", () => {
    const item = prorationItem({ amount: 1 });
    expect(item).toHaveProperty("date");
    expect(item).not.toHaveProperty("created");
  });

  it("an enable returns, and the ledger event carries, the REAL pending proration", async () => {
    const { svc, events } = make({ stripeProrationCents: 637 });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(res.proratedNow).toBe(6.37);
    const enabled = events.emit.mock.calls.find(
      (c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED,
    );
    expect(enabled?.[2]).toMatchObject({
      sku: "CUSTOMER_PACK_100",
      quantity: 1,
      prorated: 6.37,
      billed: true,
    });
  });

  it("a quantity raise nets the unused-time credit and the remaining-time line of THIS item only", async () => {
    const { svc, events } = make({
      addonRow: billedPack(2),
      priorInvoiceItems: [prorationItem({ amount: 7777, date: NOW_S() - 86400 })], // an earlier change: not this call
      invoiceItems: [
        prorationItem({ amount: -10000 }), // credit for the unused 2x
        prorationItem({ amount: 14999 }), // remaining-time charge at 3x
        prorationItem({ amount: 99999, item: "si_OTHER" }), // another item
        prorationItem({ amount: 55555, proration: false }), // not a proration line
      ],
    });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(res.proratedNow).toBe(49.99);
    const enabled = events.emit.mock.calls.find(
      (c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED,
    );
    expect(enabled?.[2]).toMatchObject({ quantity: 3, prorated: 49.99, billed: true });
  });

  it("only lines older than this call exist: proratedNow is null, the add-on is still on", async () => {
    const { svc, getRow } = make({
      addonRow: billedPack(1),
      priorInvoiceItems: [prorationItem({ amount: 5000, date: NOW_S() - 3600, item: "si_1" })],
      invoiceItems: [], // this call added nothing readable
    });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(res.proratedNow).toBeNull();
    expect(getRow()).toMatchObject({ active: true, quantity: 2 });
  });
});

describe("F6 (B1110): each change reports only ITS OWN proration lines", () => {
  /**
   * Real figures from the sandbox (RESULTS-142170de, item at 5000/month): q1 -> 3 adds -4907 / +14720,
   * q3 -> 2 adds -14720 / +9813. Before the fix a 2-second backdated window made a change within 2 s
   * of the previous one return 147.20 and 49.06 (the earlier line leaked in). Lines now are told apart
   * by id against what was pending BEFORE the call, so the clock never decides.
   */
  const lines = (c: { n: number; itemId: string; quantity: number }) =>
    c.n === 1
      ? [
          prorationItem({ amount: -4907, item: c.itemId }),
          prorationItem({ amount: 14720, item: c.itemId }),
        ]
      : [
          prorationItem({ amount: -14720, item: c.itemId }),
          prorationItem({ amount: 9813, item: c.itemId }),
        ];

  it("two changes in the SAME second: 98.13 then -49.07, never 147.20 / 49.06", async () => {
    const { svc, events } = make({ addonRow: billedPack(1), stripeLines: lines });

    const raise: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    const lower: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");

    expect(raise.proratedNow).toBe(98.13);
    expect(lower.proratedNow).toBe(-49.07);
    const prorated = events.emit.mock.calls
      .filter(
        (c: any[]) =>
          c[1] === BILLING_EVENTS.ADDON_ENABLED || c[1] === BILLING_EVENTS.ADDON_DISABLED,
      )
      .map((c: any[]) => c[2]?.prorated);
    expect(prorated).toEqual([98.13, -49.07]); // the ledger payload carries the same honest figures
  });

  it("two changes one second apart report only their own lines", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      const { svc } = make({
        addonRow: billedPack(1),
        stripeLines: (c) =>
          lines(c).map((l: any) => ({ ...l, date: Math.floor(Date.now() / 1000) })),
      });
      const raise: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
      jest.setSystemTime(Date.now() + 1000);
      const lower: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
      expect(raise.proratedNow).toBe(98.13);
      expect(lower.proratedNow).toBe(-49.07);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a pending line of the same item from an EARLIER change is not summed in", async () => {
    const { svc } = make({
      addonRow: billedPack(1),
      priorInvoiceItems: [prorationItem({ amount: 4907, item: "si_1" })], // still pending from before
      stripeLines,
    });
    function stripeLines(c: { itemId: string }) {
      return [
        prorationItem({ amount: -4907, item: c.itemId }),
        prorationItem({ amount: 14720, item: c.itemId }),
      ];
    }
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(res.proratedNow).toBe(98.13);
  });

  it("if the before-state cannot be read the figure is null (never a guess), and the change still happens", async () => {
    const m = make({ addonRow: billedPack(1), stripeLines: lines });
    m.stripeClient.invoiceItems.list.mockRejectedValueOnce(new Error("stripe blip"));
    const res: any = await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(res.proratedNow).toBeNull();
    expect(m.getRow()).toMatchObject({ quantity: 3 });
  });
});

describe("F2 (B1088): an annual subscription refuses a quantity RAISE on a billed row", () => {
  it("annual + raise 2 -> 3: the same coded 409 as enable, before any Stripe call, write or event", async () => {
    const m = make({ sub: ANNUAL_SUB, addonRow: billedPack(2) });
    const err = await rejection(m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(ANNUAL_REFUSAL);
    expect(err.message).toBe(ANNUAL_COPY);
    expectUntouched(m);
    expect(m.getRow()).toMatchObject({ quantity: 2, stripeItemId: "si_1" });
  });

  it("a cycle-only annual row (no billingInterval) is annual by the SAME predicate enable uses", async () => {
    const m = make({
      sub: { ...ACTIVE_SUB, billingInterval: null, cycle: "ANNUAL" },
      addonRow: billedPack(1),
    });
    const err = await rejection(m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(ANNUAL_REFUSAL);
    expectUntouched(m);
  });

  it("annual + decrease 3 -> 2 stays allowed (the item is updated, the ledger gives back one unit)", async () => {
    const m = make({ sub: ANNUAL_SUB, addonRow: billedPack(3) });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(m.stripeClient.subscriptionItems.update).toHaveBeenCalledWith("si_1", {
      quantity: 2,
      proration_behavior: "create_prorations",
    });
    expect(m.getRow()).toMatchObject({ quantity: 2 });
    const disabled = m.events.emit.mock.calls.filter(
      (c: any[]) => c[1] === BILLING_EVENTS.ADDON_DISABLED,
    );
    expect(disabled.map((c: any[]) => c[3]?.amountDelta)).toEqual([-12]);
  });

  it("annual + disable stays allowed (the item is removed)", async () => {
    const m = make({ sub: ANNUAL_SUB, addonRow: billedPack(2) });
    await m.svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(m.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(m.getRow()).toMatchObject({ active: false, stripeItemId: null });
  });

  it("monthly + raise 2 -> 3 is unchanged (the item is updated and the ledger books one unit)", async () => {
    const m = make({ addonRow: billedPack(2) });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(m.stripeClient.subscriptionItems.update).toHaveBeenCalledWith("si_1", {
      quantity: 3,
      proration_behavior: "create_prorations",
    });
    expect(enabledDeltas(m.events)).toEqual([12]);
  });
});

describe("F3: an add-on the tenant's plan already includes can't be bought", () => {
  it("SCALE + FORECASTING: refused with the fixed code and copy; no Stripe call, row or MRR", async () => {
    const m = make({ planKey: "SCALE" });
    const err = await rejection(m.svc.enableAddon("t1", "FORECASTING", 1, "u1"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(INCLUDED_REFUSAL);
    expectUntouched(m);
    expect(m.getRow()).toBeNull();
  });

  it.each([
    ["ENTERPRISE (above the bundling plan)", { planKey: "ENTERPRISE" }],
    ["the legacy BUSINESS alias of SCALE", { planKey: "BUSINESS" }],
    [
      "a subscription with no planKey, Tenant.plan PROFESSIONAL (= SCALE)",
      { planKey: null, tenantPlan: "PROFESSIONAL" },
    ],
  ])("refused on %s", async (_label, plan) => {
    const m = make(plan as any);
    const err = await rejection(m.svc.enableAddon("t1", "FORECASTING", 1, "u1"));
    expect(err?.getResponse()).toEqual(INCLUDED_REFUSAL);
    expectUntouched(m);
  });

  it("refused for a free pilot (no subscription) and a manually-invoiced tenant on SCALE too", async () => {
    const pilot = make({ sub: null, tenantPlan: "SCALE" });
    expect(
      (await rejection(pilot.svc.enableAddon("t1", "FORECASTING", 1, "u1")))?.getResponse(),
    ).toEqual(INCLUDED_REFUSAL);
    expectUntouched(pilot);
    const manual = make({ sub: MANUAL_SUB, planKey: null, tenantPlan: "SCALE" });
    expect(
      (await rejection(manual.svc.enableAddon("t1", "FORECASTING", 1, "u1")))?.getResponse(),
    ).toEqual(INCLUDED_REFUSAL);
    expectUntouched(manual);
    expect(manual.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("STARTER + FORECASTING and GROWTH + FORECASTING are allowed (billed at the catalog price)", async () => {
    for (const planKey of ["STARTER", "GROWTH"]) {
      const m = make({ planKey });
      await m.svc.enableAddon("t1", "FORECASTING", 1, "u1");
      expect(m.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect(m.getRow()).toMatchObject({ active: true, priceSnapshot: 25 });
      expect(enabledDeltas(m.events)).toEqual([25]);
    }
  });

  it("an add-on with no bundling plan (CUSTOMER_PACK_100) is allowed on SCALE", async () => {
    const m = make({ planKey: "SCALE" });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(m.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
  });

  it("a tenant that bought it before upgrading to SCALE can't re-enable or raise it, but can still disable it", async () => {
    const row = {
      id: "a1",
      addonKey: "FORECASTING",
      sku: "FORECASTING",
      active: true,
      quantity: 1,
      priceSnapshot: 25,
      stripeItemId: "si_1",
    };
    const m = make({ planKey: "SCALE", addonRow: row });
    const err = await rejection(m.svc.enableAddon("t1", "FORECASTING", 1, "u1"));
    expect(err?.getResponse()).toEqual(INCLUDED_REFUSAL);
    expectUntouched(m);
    await m.svc.disableAddon("t1", "FORECASTING", "u1");
    expect(m.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(m.getRow()).toMatchObject({ active: false });
  });
});

describe("preview agreement: addonEnableRefusal says what enableAddon will do", () => {
  const cases: Array<[string, string, Opts, { code: string; message: string } | null]> = [
    ["annual Stripe, new add-on", "CUSTOMER_PACK_100", { sub: ANNUAL_SUB }, ANNUAL_REFUSAL],
    ["plan-included (SCALE)", "FORECASTING", { planKey: "SCALE" }, INCLUDED_REFUSAL],
    [
      "plan-included wins over annual",
      "FORECASTING",
      { sub: ANNUAL_SUB, planKey: "SCALE" },
      INCLUDED_REFUSAL,
    ],
    ["monthly Stripe on STARTER", "FORECASTING", { planKey: "STARTER" }, null],
    ["free pilot", "CUSTOMER_PACK_100", { sub: null }, null],
    ["manually invoiced", "CUSTOMER_PACK_100", { sub: MANUAL_SUB }, null],
  ];

  it.each(cases)("%s", async (_label, sku, opts, expected) => {
    const preview = make(opts);
    expect(await preview.svc.addonEnableRefusal("t1", sku)).toEqual(expected);
    // The enable path on an identical tenant refuses iff the preview did, with the same body.
    const enable = make(opts);
    const err = await rejection(enable.svc.enableAddon("t1", sku, 1, "u1"));
    if (expected) {
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(expected);
    } else {
      expect(err).toBeUndefined();
    }
  });

  it("an unknown SKU has no refusal (the preview's own 400 covers it)", async () => {
    const m = make();
    expect(await m.svc.addonEnableRefusal("t1", "NOPE")).toBeNull();
  });
});

// SA-693 (owner ruling 2026-10-05 "Mark grants as comps"): a comp is a platform grant, never billed.
// Self-serve is billable by definition: it never writes a comp, and it re-bills a comp that was turned
// off. An ACTIVE comp's quantity is the platform's to manage, so a tenant change is a coded 409.
describe("SA-693 — self-serve add-on vs comp rows", () => {
  const comp = {
    id: "a1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    active: true,
    quantity: 1,
    priceSnapshot: 0,
    stripeItemId: null,
    isComp: true,
  };

  it("pins the wire code", () => {
    expect(API_ERROR_CODES.ADDON_COMP_MANAGED_BY_SUPPORT).toBe("ADDON_COMP_MANAGED_BY_SUPPORT");
  });

  it("the preview agrees with the enable call: an ACTIVE comp is REFUSED (no charge line), a disabled one is not", async () => {
    const active = make({ addonRow: comp });
    expect(await active.svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100")).toEqual({
      code: "ADDON_COMP_MANAGED_BY_SUPPORT",
      message: expect.any(String),
    });
    const disabled = make({ addonRow: { ...comp, active: false } });
    expect(await disabled.svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100")).toBeNull();
  });

  it("a quantity change on an ACTIVE comp is a coded 409: no Stripe, no write, no ledger event", async () => {
    const { svc, stripeClient, tenantAddon, events, getRow } = make({ addonRow: comp });

    const err: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "ADDON_COMP_MANAGED_BY_SUPPORT" });
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.update).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ quantity: 1, isComp: true });
  });

  it("the same quantity on an active comp stays an idempotent no-op (never an error, never a bill)", async () => {
    const { svc, stripeClient, tenantAddon, getRow } = make({ addonRow: comp });

    await expect(svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1")).resolves.toBeDefined();

    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ isComp: true, stripeItemId: null });
  });

  it("a self-serve re-enable of a DISABLED comp BILLS: Stripe item, isComp false, price booked", async () => {
    const { svc, stripeClient, getRow, events } = make({
      addonRow: { ...comp, active: false },
    });

    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");

    expect(stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(getRow()).toMatchObject({
      active: true,
      isComp: false,
      stripeItemId: "si_1",
      priceSnapshot: 12,
    });
    expect(enabledDeltas(events)).toEqual([12]);
  });

  it("a self-serve enable of a brand-new row writes isComp false", async () => {
    const { svc, tenantAddon } = make({ addonRow: null });

    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");

    expect(tenantAddon.upsert.mock.calls[0][0].create.isComp).toBe(false);
    expect(tenantAddon.upsert.mock.calls[0][0].update.isComp).toBe(false);
  });

  it("disabling an active comp is allowed and books nothing", async () => {
    const { svc, getRow, events } = make({ addonRow: comp });

    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");

    expect(getRow()).toMatchObject({ active: false });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
