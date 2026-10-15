/**
 * SA-786 S3 / R7 / R7b - the post-commit Stripe half of "an add-on the old plan included starts to bill".
 * `billAddonsLeavingInclusion` creates ONE monthly item at the catalog price of the TARGET version, with
 * `always_invoice` and a `proration_date` pinned to the new period's start (one full period on its own invoice,
 * lead ruling R1 note), claims it onto the row through the guarded compare-and-swap, and is idempotent: a replay
 * re-reads each row and makes ZERO Stripe calls for a row that is no longer a $0 non-comp row with no item.
 * A Stripe period that is not the local new period start (not renewed yet, or drifted) is never prorated from a
 * guessed date: it throws, and the caller flags the tenant and writes a notice.
 *
 * Stripe is mocked at the StripeService boundary: no live call anywhere here. On master the method does not exist,
 * so every row below is red there (new capability, labelled).
 */
const mockWithAdvisoryLock = jest.fn(async (_o: unknown, fn: () => Promise<unknown>) => ({
  acquired: true as const,
  value: await fn(),
}));
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { ConflictException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

const NEW_START = new Date("2026-11-11T00:00:00.000Z");
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const SKUS = [
  { sku: "REGULATED_ITEMS", name: "Regulated items", monthlyPrice: 39, includedAtPlan: "SCALE" },
];

const leaving = (over: Record<string, unknown> = {}) => ({
  id: "ta_reg",
  tenantId: "t1",
  addonKey: "REGULATED_ITEMS",
  sku: "REGULATED_ITEMS",
  quantity: 1,
  priceSnapshot: 0,
  stripeItemId: null as string | null,
  isComp: false,
  active: true,
  ...over,
});

function make(
  o: {
    periodStart?: Date;
    sub?: Record<string, unknown>;
    addons?: any[];
    createFails?: boolean;
  } = {},
) {
  const db = {
    sub: {
      stripeSubId: "sub_1",
      externalPayment: false,
      couponFull: false,
      billingInterval: "month",
      cycle: "MONTHLY",
      planKey: "GROWTH",
      ...(o.sub ?? {}),
    },
    addons: (o.addons ?? [leaving()]).map((r) => ({ ...r })),
  };
  const stripe: any = {
    isConfigured: true,
    getSubscription: jest.fn(async () => ({
      id: "sub_1",
      status: "active",
      items: {
        data: [
          {
            id: "si_base",
            quantity: 1,
            current_period_start: unix(o.periodStart ?? NEW_START),
            current_period_end: unix(o.periodStart ?? NEW_START) + 30 * 86400,
            price: { unit_amount: 24900 },
          },
        ],
      },
    })),
    client: {
      products: { create: jest.fn(async () => ({ id: "prod_reg" })) },
      subscriptionItems: {
        list: jest.fn(async () => ({ data: [] })),
        create: jest.fn(async (params: any) => {
          if (o.createFails) throw new Error("stripe down");
          return { id: "si_new", ...params };
        }),
        del: jest.fn(async () => ({})),
        update: jest.fn(),
      },
    },
  };
  const matches = (r: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) =>
      k === "OR" ? true : v && typeof v === "object" ? true : r[k] === v,
    );
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantSubscription: {
      findUnique: jest.fn(async () => ({ stripeSubId: db.sub.stripeSubId })),
    },
    tenantAddon: {
      findUnique: jest.fn(async ({ where }: any) => db.addons.find((r) => r.id === where.id)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = db.addons.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "GROWTH", couponFull: false },
      }),
    },
  };
  const prisma: any = {
    tenantSubscription: { findUnique: jest.fn(async () => ({ ...db.sub })) },
    tenant: { findUnique: jest.fn().mockResolvedValue({ plan: "TEAM" }) },
    tenantAddon: {
      findUnique: jest.fn(async ({ where }: any) => db.addons.find((r) => r.id === where.id)),
      findMany: jest.fn(async () => []),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const events: any = { emit: jest.fn().mockResolvedValue({}) };
  const catalog: any = {
    getPublishedCatalog: jest
      .fn()
      .mockResolvedValue({ id: "v8", definitions: [], addonSkus: SKUS }),
    getVersionForTenant: jest.fn(),
    getPublishedVersion: jest.fn(),
  };
  const svc = new SubscriptionMutationService(
    prisma,
    catalog,
    {} as any,
    {} as any,
    { invalidate: jest.fn() } as any,
    events,
    { invalidate: jest.fn() } as any,
    stripe,
    {} as any,
    {} as any,
  );
  const bill = (opts?: Record<string, unknown>) =>
    (svc as any).billAddonsLeavingInclusion(
      "t1",
      [{ ...leaving(), code: "REGULATED_ITEMS", monthlyPrice: 39 }],
      SKUS,
      "plan_change",
      { prorationBehavior: "always_invoice", prorationDate: NEW_START, ...(opts ?? {}) },
    );
  const stripeCalls = () =>
    stripe.getSubscription.mock.calls.length +
    stripe.client.products.create.mock.calls.length +
    stripe.client.subscriptionItems.list.mock.calls.length +
    stripe.client.subscriptionItems.create.mock.calls.length;
  return { svc, db, stripe, events, tx, bill, stripeCalls };
}

describe("billAddonsLeavingInclusion (SA-786 R7 / R7b)", () => {
  it("R7: creates ONE item at the catalog price: 3900 cents, always_invoice, proration_date = the new period start; the row carries it and +39 books once", async () => {
    const { bill, stripe, db, events } = make();
    await bill();

    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    const [params] = stripe.client.subscriptionItems.create.mock.calls[0];
    expect(params).toMatchObject({
      subscription: "sub_1",
      quantity: 1,
      proration_behavior: "always_invoice",
      proration_date: unix(NEW_START),
      price_data: { currency: "usd", unit_amount: 3900, recurring: { interval: "month" } },
    });
    expect(db.addons[0]).toMatchObject({ stripeItemId: "si_new", priceSnapshot: 39, active: true });
    const booked = events.emit.mock.calls.filter(
      (c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED,
    );
    expect(booked).toHaveLength(1);
    expect(booked[0][3].amountDelta).toBe(39);
    expect(booked[0][2]).toMatchObject({ billed: true, source: "plan_change" });
  });

  it("R7b replay: a second run makes ZERO Stripe calls and leaves one item", async () => {
    const { bill, stripe, db, stripeCalls } = make();
    await bill();
    const after = stripeCalls();
    await bill();

    expect(stripeCalls()).toBe(after);
    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(db.addons).toHaveLength(1);
  });

  it("R7b mismatch: Stripe's current_period_start is not the local new period start -> throws, ZERO items created, the row untouched", async () => {
    const { bill, stripe, db } = make({ periodStart: new Date("2026-10-11T00:00:00.000Z") });
    await expect(bill()).rejects.toBeDefined();

    expect(stripe.client.products.create).not.toHaveBeenCalled();
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(db.addons[0]).toMatchObject({ stripeItemId: null, priceSnapshot: 0 });
  });

  it("a Stripe create failure throws (the caller flags the tenant) and writes nothing to the row", async () => {
    const { bill, db } = make({ createFails: true });
    await expect(bill()).rejects.toBeDefined();
    expect(db.addons[0]).toMatchObject({ stripeItemId: null, priceSnapshot: 0 });
  });

  it("a lost claim (the row changed under the call) removes the item it created and fails the call", async () => {
    const { bill, stripe, tx } = make();
    tx.tenantAddon.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(bill()).rejects.toBeInstanceOf(ConflictException);
    expect(stripe.client.subscriptionItems.del).toHaveBeenCalledWith("si_new", {
      proration_behavior: "create_prorations",
    });
  });

  it("a MANUAL tenant (no live Stripe subscription) is not billed through Stripe: no call, no throw", async () => {
    const { bill, stripeCalls } = make({ sub: { stripeSubId: null, externalPayment: true } });
    await bill();
    expect(stripeCalls()).toBe(0);
  });

  it("an ANNUAL Stripe subscription stays unbilled (online add-ons are monthly items): no call", async () => {
    const { bill, stripeCalls } = make({ sub: { billingInterval: "year", cycle: "ANNUAL" } });
    await bill();
    expect(stripeCalls()).toBe(0);
  });

  it("a comp row, a quantity > 1 row and a row that already has an item are never billed", async () => {
    for (const over of [
      { isComp: true },
      { quantity: 3 },
      { stripeItemId: "si_x", priceSnapshot: 39 },
    ]) {
      const { bill, stripeCalls } = make({ addons: [leaving(over)] });
      await bill();
      expect(stripeCalls()).toBe(0);
    }
  });
});
