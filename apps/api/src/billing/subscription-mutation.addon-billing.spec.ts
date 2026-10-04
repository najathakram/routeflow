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

const CATALOG = {
  addonSkus: [
    { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12 },
    { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25 },
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
  stripeTenantSubFor?: string;
}

const NOW_S = () => Math.floor(Date.now() / 1000);

function make(opts: Opts = {}) {
  // The subscription's items as Stripe holds them, so a lost response leaves a REAL orphan.
  const stripeItems: any[] = [];
  let itemSeq = 0;
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
            if (opts.createTimesOutAfterCreating) throw new Error("ETIMEDOUT");
            return item;
          }),
      list: jest.fn(async ({ subscription }: any) => ({
        data: stripeItems.filter((i) => i.subscription === subscription),
      })),
      update: opts.updateFails
        ? jest.fn().mockRejectedValue(opts.updateFails)
        : jest.fn().mockResolvedValue({ id: "si_1" }),
      del: opts.delFails
        ? jest.fn().mockRejectedValue(opts.delFails)
        : jest.fn(async (id: string) => {
            const i = stripeItems.findIndex((x) => x.id === id);
            if (i >= 0) stripeItems.splice(i, 1);
            return {};
          }),
    },
    invoiceItems: {
      list: jest.fn().mockResolvedValue({
        data:
          opts.stripeProrationCents == null
            ? []
            : [
                {
                  proration: true,
                  amount: opts.stripeProrationCents,
                  created: NOW_S(),
                  parent: { subscription_details: { subscription_item: "si_1" } },
                },
                // an OLDER proration line of the same item (e.g. an earlier quantity change): not ours
                {
                  proration: true,
                  amount: 7777,
                  created: NOW_S() - 86400,
                  parent: { subscription_details: { subscription_item: "si_1" } },
                },
                {
                  proration: true,
                  amount: 99999,
                  created: NOW_S(),
                  parent: { subscription_details: { subscription_item: "si_OTHER" } },
                },
                // not a proration line of ours, same item: must not be summed
                {
                  proration: false,
                  amount: 55555,
                  created: NOW_S(),
                  parent: { subscription_details: { subscription_item: "si_1" } },
                },
              ],
      }),
    },
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
      findUnique: jest.fn().mockResolvedValue({ slug: "acme", name: "Acme Foods" }),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.sub === undefined ? ACTIVE_SUB : opts.sub),
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
      expect.objectContaining({
        customer: "cus_t1",
        pending: true,
        created: { gte: expect.any(Number) },
      }),
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
