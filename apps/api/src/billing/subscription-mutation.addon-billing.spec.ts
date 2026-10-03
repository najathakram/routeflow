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
  delFails?: unknown;
  updateFails?: unknown;
  txFails?: boolean;
  stripeProrationCents?: number | null;
  stripeTenantSubFor?: string;
}

function make(opts: Opts = {}) {
  const stripeClient = {
    products: { create: jest.fn().mockResolvedValue({ id: "prod_1" }) },
    subscriptionItems: {
      create: opts.createFails
        ? jest.fn().mockRejectedValue(opts.createFails)
        : jest.fn().mockResolvedValue({ id: "si_1" }),
      update: opts.updateFails
        ? jest.fn().mockRejectedValue(opts.updateFails)
        : jest.fn().mockResolvedValue({ id: "si_1" }),
      del: opts.delFails
        ? jest.fn().mockRejectedValue(opts.delFails)
        : jest.fn().mockResolvedValue({}),
    },
    invoiceItems: {
      list: jest.fn().mockResolvedValue({
        data:
          opts.stripeProrationCents == null
            ? []
            : [
                { proration: true, subscription_item: "si_1", amount: opts.stripeProrationCents },
                { proration: true, subscription_item: "si_OTHER", amount: 99999 },
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
  };
  const tx = {
    tenantAddon,
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
  return { svc, prisma, tx, tenantAddon, stripeClient, events, entitlements, getRow: () => row };
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
    const { svc, stripeClient, tenantAddon, events } = make({
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

  it("isAddonBilled tells the preview whether the tenant is billed through Stripe", async () => {
    expect(await make().svc.isAddonBilled("t1")).toBe(true);
    expect(await make({ sub: { ...ACTIVE_SUB, stripeSubId: null } }).svc.isAddonBilled("t1")).toBe(
      false,
    );
    expect(await make({ stripeConfigured: false }).svc.isAddonBilled("t1")).toBe(false);
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
    await svc.isAddonBilled("t1");
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
