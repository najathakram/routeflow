/**
 * B1079 (SA ruling) - the checkout-completion add-on adoption decides through the ONE add-on mode
 * (`addonModeOf`), like enable and disable do. `adoptCheckoutAddons` path (c) - an ACTIVE row with no
 * Stripe item and no checkout line - is the only place it CREATES a Stripe item (`billUnbilledRow`): on a
 * tenant whose subscription is `couponFull` (a 100% coupon, an UNBILLED pilot) it must create none.
 *
 * `couponFull` is not synced yet when the completion runs (the handler syncs it LAST), so the decision
 * reads it the way the coupon sync does - Stripe's retrieve + upcoming-invoice preview
 * (`readCouponStateFromStripe`) - and falls back to the stored column only when Stripe has nothing to
 * say. A Stripe failure fails the webhook (retried); it never creates the item on a guess.
 *
 * Stripe is mocked at the module boundary (`StripeService`) - no live Stripe.
 */
const mockWithAdvisoryLock = jest.fn(
  async (_opts: { key: string }, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: await fn(),
  }),
);
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { SubscriptionMutationService } from "./subscription-mutation.service";

const CATALOG = {
  addonSkus: [{ sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 50 }],
  definitions: [],
};

/** The upcoming-invoice preview of a subscription whose only recurring line is fully discounted. */
const FULL_PREVIEW = {
  total: 0,
  total_discount_amounts: [{ amount: 9900 }],
  lines: {
    has_more: false,
    data: [
      {
        amount: 9900,
        discount_amounts: [{ amount: 9900 }],
        parent: {
          type: "subscription_item_details",
          subscription_item_details: { proration: false },
        },
      },
    ],
  },
};

/** A 50% coupon: discounted, but still billed. */
const PARTIAL_PREVIEW = {
  total: 4950,
  total_discount_amounts: [{ amount: 4950 }],
  lines: {
    has_more: false,
    data: [
      {
        amount: 9900,
        discount_amounts: [{ amount: 4950 }],
        parent: {
          type: "subscription_item_details",
          subscription_item_details: { proration: false },
        },
      },
    ],
  },
};

interface Opts {
  /** TenantSubscription.couponFull as stored (not synced yet at the first completion). */
  storedCouponFull?: boolean;
  /** What Stripe's upcoming-invoice preview says (null = "no upcoming invoice"). */
  preview?: unknown;
  /** The coupon sync's Stripe read fails. */
  stripeReadFails?: boolean;
  /** The checkout's own add-on LINE made this item on the subscription (the session priced it at full price). */
  checkoutItem?: boolean;
}

function make(opts: Opts = {}) {
  const row: any = {
    id: "a1",
    tenantId: "t1",
    addonKey: "CUSTOMER_PACK_100",
    sku: "CUSTOMER_PACK_100",
    quantity: 2,
    active: true,
    priceSnapshot: 0,
    stripeItemId: null,
    isComp: false,
    createdAt: new Date(1_790_000_000_000),
  };
  const sub: any = {
    tenantId: "t1",
    planKey: "STARTER",
    stripeSubId: "sub_1",
    stripeCustomerId: "cus_1",
    billingInterval: "month",
    cycle: "MONTHLY",
    externalPayment: false,
    couponFull: opts.storedCouponFull ?? false,
  };
  const tenantAddon = {
    findMany: jest.fn(async () => [{ ...row }]),
    findFirst: jest.fn(async () => ({ ...row })),
    findUnique: jest.fn(async () => ({ ...row })),
    updateMany: jest.fn(async ({ data }: any) => {
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const stripeClient = {
    products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
    subscriptionItems: {
      list: jest.fn(async () => ({ data: [] })),
      create: jest.fn(async (args: any) => ({ id: "si_new", quantity: args.quantity })),
      update: jest.fn(async (id: string) => ({ id })),
      del: jest.fn(async () => ({})),
    },
    invoiceItems: { list: jest.fn(async () => ({ data: [] })) },
  };
  const stripe = {
    isConfigured: true,
    client: stripeClient,
    retrieveSubscriptionWithDiscounts: jest.fn(async (id: string) => {
      if (opts.stripeReadFails) throw new Error("stripe down: internal detail");
      return { id, status: "active", discounts: [] };
    }),
    previewNextInvoice: jest.fn(async () => (opts.preview === undefined ? null : opts.preview)),
  } as any;
  const tx = {
    tenantAddon,
    tenantSubscription: { findUnique: jest.fn(async () => ({ ...sub })) },
    tenant: {
      findUniqueOrThrow: jest.fn(async () => ({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "STARTER", couponFull: false },
      })),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    tenantAddon,
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ slug: "acme", name: "Acme", plan: "STARTER" }),
    },
    tenantSubscription: { findUnique: jest.fn(async () => ({ ...sub })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const svc = new SubscriptionMutationService(
    prisma,
    { getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG) } as any,
    {} as any,
    { getSubscription: jest.fn().mockResolvedValue({}) } as any,
    { invalidate: jest.fn() } as any,
    events,
    { invalidate: jest.fn() } as any,
    stripe,
    {} as any,
    { prepare: jest.fn(), onPlanChange: jest.fn() } as any,
  );
  /** The subscription the completion retrieved: only the base plan item - the session had no line for the add-on. */
  const stripeSub = {
    id: "sub_1",
    items: {
      data: [
        { id: "si_base", price: { product: {} } },
        ...(opts.checkoutItem
          ? [
              {
                id: "si_line",
                quantity: 2,
                price: {
                  unit_amount: 5000,
                  product: { metadata: { addonSku: "CUSTOMER_PACK_100" } },
                },
              },
            ]
          : []),
      ],
    },
  };
  const adopt = () => svc.adoptCheckoutAddons("t1", stripeSub, { sessionId: "cs_1" });
  return { adopt, row, stripe, stripeClient, events };
}

const noItemCreated = (h: ReturnType<typeof make>) => {
  expect(h.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  expect(h.stripeClient.subscriptionItems.list).not.toHaveBeenCalled();
  expect(h.stripeClient.products.create).not.toHaveBeenCalled();
  expect(h.row).toMatchObject({ stripeItemId: null, priceSnapshot: 0, quantity: 2, active: true });
  expect(h.events.emit).not.toHaveBeenCalled();
};

describe("B1079 - checkout completion does not bill add-ons of a couponFull tenant", () => {
  it("couponFull stored true: an unbilled add-on gets NO Stripe item and books nothing", async () => {
    const h = make({ storedCouponFull: true });
    await h.adopt();
    noItemCreated(h);
  });

  it("couponFull not synced yet (stored false) but Stripe's upcoming invoice is fully discounted: NO item", async () => {
    const h = make({ storedCouponFull: false, preview: FULL_PREVIEW });
    await h.adopt();
    noItemCreated(h);
    expect(h.stripe.previewNextInvoice).toHaveBeenCalledWith("sub_1");
  });

  it("the Stripe read FAILS: the webhook fails (retried) and no item is created on a guess", async () => {
    const h = make({ storedCouponFull: false, stripeReadFails: true });
    await expect(h.adopt()).rejects.toThrow();
    noItemCreated(h);
  });

  it("couponFull = false (no coupon, no upcoming invoice read): the add-on is still billed - ONE item, catalog price", async () => {
    const h = make({ storedCouponFull: false, preview: null });
    await h.adopt();
    expect(h.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(h.stripeClient.subscriptionItems.create.mock.calls[0][0]).toMatchObject({
      subscription: "sub_1",
      quantity: 2,
      price_data: { unit_amount: 5000 },
    });
    expect(h.row).toMatchObject({ stripeItemId: "si_new", priceSnapshot: 50, quantity: 2 });
  });

  it("a PARTIAL coupon (50%) is still billed: only a fully discounted invoice reads as couponFull", async () => {
    const h = make({ storedCouponFull: false, preview: PARTIAL_PREVIEW });
    await h.adopt();
    expect(h.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(h.row).toMatchObject({ stripeItemId: "si_new", priceSnapshot: 50 });
  });

  it("a stale stored couponFull=true does not beat a fresh Stripe read that says the invoice is billed again", async () => {
    const h = make({ storedCouponFull: true, preview: PARTIAL_PREVIEW });
    await h.adopt();
    expect(h.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
  });
});

describe("B1079 - the checkout's own add-on LINE does not bill a couponFull tenant either", () => {
  it("couponFull: the item the checkout line made is removed (prorated), nothing is adopted, the row stays unbilled", async () => {
    const h = make({ storedCouponFull: false, preview: FULL_PREVIEW, checkoutItem: true });
    await h.adopt();
    expect(h.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(h.stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_line", {
      proration_behavior: "create_prorations",
    });
    expect(h.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({
      stripeItemId: null,
      priceSnapshot: 0,
      quantity: 2,
      active: true,
    });
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("the removal can only CREDIT: prorated, never an invoice-now, and no item is created or raised", async () => {
    const h = make({ storedCouponFull: false, preview: FULL_PREVIEW, checkoutItem: true });
    await h.adopt();
    const [itemId, opts] = h.stripeClient.subscriptionItems.del.mock.calls[0] as unknown as [
      string,
      any,
    ];
    expect(itemId).toBe("si_line");
    // create_prorations on a delete makes a credit line (<= 0) for the unused time and bills nothing now
    expect(opts).toEqual({ proration_behavior: "create_prorations" });
    expect(opts.proration_behavior).not.toBe("always_invoice");
    expect(h.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(h.stripeClient.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it("a Stripe read failure with a checkout item present fails the webhook and deletes nothing", async () => {
    const h = make({ stripeReadFails: true, checkoutItem: true });
    await expect(h.adopt()).rejects.toThrow();
    expect(h.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.row.stripeItemId).toBeNull();
  });

  it("a normally billed tenant (no coupon) still adopts the checkout's item", async () => {
    const h = make({ storedCouponFull: false, preview: null, checkoutItem: true });
    await h.adopt();
    expect(h.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({ stripeItemId: "si_line", priceSnapshot: 50, quantity: 2 });
  });
});
