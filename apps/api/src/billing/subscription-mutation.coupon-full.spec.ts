/**
 * B1079 - the add-on billing mode honours `couponFull` (owner ruling: a pilot on a 100% coupon is
 * UNBILLED). A tenant that has a live Stripe subscription whose recurring invoice is $0 because of a
 * coupon (`TenantSubscription.couponFull`, the SA-736r flag `isPayingRow` reads) must not be billed for
 * add-ons: the add-on is granted at price 0, books no revenue and NO Stripe subscription item is created.
 *
 *  A enable on a couponFull + Stripe tenant: no Stripe call, row on at 0, nothing booked, "UNBILLED"
 *  B couponFull = false + Stripe: unchanged (Stripe item created, billed)
 *  C couponFull without a Stripe subscription: unchanged (externalPayment stays MANUAL, a pilot UNBILLED)
 *  D disable with couponFull (an unbilled row never calls Stripe; a row that already has an item still
 *    removes it, so nothing keeps billing)
 *  E every reader of the ONE mode decision agrees: addonBillingMode, addonEnableRefusal, the raise path
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

import { ConflictException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

const CATALOG = {
  addonSkus: [
    { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12, stackable: true },
  ],
  definitions: [],
};

const STRIPE_SUB = {
  tenantId: "t1",
  stripeSubId: "sub_t1",
  stripeCustomerId: "cus_t1",
  billingInterval: "month",
  cycle: "MONTHLY",
  externalPayment: false,
};

const ROW = {
  id: "a1",
  addonKey: "CUSTOMER_PACK_100",
  sku: "CUSTOMER_PACK_100",
  active: true,
  quantity: 1,
  priceSnapshot: 0,
  stripeItemId: null as string | null,
};

function make(opts: {
  sub: Record<string, unknown> | null;
  addonRow?: Record<string, unknown> | null;
}) {
  const stripeClient = {
    products: { create: jest.fn().mockResolvedValue({ id: "prod_1" }) },
    subscriptionItems: {
      create: jest.fn(async (args: any) => ({ id: "si_new", quantity: args.quantity })),
      list: jest.fn(async () => ({ data: [] })),
      update: jest.fn(async (id: string) => ({ id })),
      del: jest.fn(async () => ({})),
    },
    invoiceItems: { list: jest.fn(async () => ({ data: [] })) },
  };
  const stripe = { isConfigured: true, client: stripeClient } as any;

  let row: any = opts.addonRow ? { ...opts.addonRow } : null;
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
    findMany: jest.fn(async () => []),
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
      findUnique: jest
        .fn()
        .mockResolvedValue({ slug: "acme", name: "Acme Foods", plan: "STARTER" }),
    },
    // The mock returns the whole row whatever `select` asks for, so a service that does NOT select
    // `couponFull` would still see it here: the pins below prove the DECISION, and the select is
    // pinned separately (see "selects couponFull").
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(opts.sub) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const svc = new SubscriptionMutationService(
    prisma,
    { getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG) } as any,
    { prorationPreview: jest.fn().mockResolvedValue({ proratedToday: 6.4 }) } as any,
    { getSubscription: jest.fn().mockResolvedValue({ planKey: "TEAM" }) } as any,
    { invalidate: jest.fn() } as any,
    events,
    { invalidate: jest.fn() } as any,
    stripe,
    { notifyUpgradeConfirmed: jest.fn(), notifyDowngradeScheduled: jest.fn() } as any,
    { prepare: jest.fn(), onPlanChange: jest.fn() } as any,
  );
  return { svc, prisma, tx, tenantAddon, stripeClient, events, getRow: () => row };
}

const enabledDeltas = (events: any) =>
  events.emit.mock.calls
    .filter((c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED)
    .map((c: any[]) => c[3]?.amountDelta);

describe("B1079 A - couponFull + a live Stripe subscription: add-ons are UNBILLED", () => {
  const sub = { ...STRIPE_SUB, couponFull: true };

  it("enable creates NO Stripe item, no product, no charge: the add-on is on at price 0 and books nothing", async () => {
    const { svc, stripeClient, tenantAddon, events, tx } = make({ sub });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");

    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.list).not.toHaveBeenCalled();
    expect(stripeClient.products.create).not.toHaveBeenCalled();
    expect(tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          active: true,
          quantity: 1,
          priceSnapshot: 0,
          stripeItemId: null,
        }),
      }),
    );
    expect(enabledDeltas(events)).toEqual([]); // never revenue we do not bill
    expect(res.billing).toBe("UNBILLED");
    expect(res.proratedNow).toBe(0);
    expect(tx.auditLog.create).not.toHaveBeenCalled(); // no manual-invoice notice either
  });

  it("a quantity of 3 is granted too, still at 0 and with no Stripe call", async () => {
    const { svc, stripeClient, getRow } = make({ sub });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ active: true, quantity: 3, priceSnapshot: 0 });
  });

  it("a quantity RAISE on an active unbilled row is allowed at 0 (it is refused only for a billed tenant)", async () => {
    const { svc, stripeClient, getRow, events } = make({ sub, addonRow: ROW });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripeClient.subscriptionItems.update).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ active: true, quantity: 2, priceSnapshot: 0 });
    expect(enabledDeltas(events)).toEqual([]);
    expect(res.billing).toBe("UNBILLED");
  });

  it("a legacy non-zero snapshot on an unbilled row is withdrawn, never grown", async () => {
    const { svc, stripeClient, getRow, events } = make({
      sub,
      addonRow: { ...ROW, priceSnapshot: 12 },
    });
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ quantity: 2, priceSnapshot: 0 });
    // Only the withdrawal of the stale 12 is booked (12 x 1 -> 0 x 2): never an enable.
    expect(enabledDeltas(events)).toEqual([]);
    expect(
      events.emit.mock.calls
        .filter((c: any[]) => c[1] !== "addon.state_changed")
        .map((c: any[]) => c[3]?.amountDelta),
    ).toEqual([-12]);
  });

  it("the billing mode, and the preview's refusal on an ANNUAL coupon subscription, agree with enable", async () => {
    const { svc } = make({ sub });
    expect(await svc.addonBillingMode("t1")).toBe("UNBILLED");

    // Nothing is billed, so nothing can be "refused as annual": the same sub on a yearly interval.
    const annual = make({ sub: { ...sub, billingInterval: "year", cycle: "ANNUAL" } });
    expect(await annual.svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100")).toBeNull();
    await annual.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(annual.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(annual.getRow()).toMatchObject({ active: true, priceSnapshot: 0 });
  });

  it("selects couponFull when it reads the subscription (the decision cannot rest on a column nobody read)", async () => {
    const { svc, prisma } = make({ sub });
    await svc.addonBillingMode("t1");
    const select = prisma.tenantSubscription.findUnique.mock.calls[0][0].select;
    expect(select).toMatchObject({ couponFull: true });
  });
});

describe("B1079 B - couponFull = false (or never set) + a live Stripe subscription: unchanged", () => {
  it.each([[false], [undefined]])(
    "couponFull=%s: ONE Stripe item is created, the add-on is priced and booked",
    async (couponFull) => {
      const { svc, stripeClient, tenantAddon, events } = make({
        sub: { ...STRIPE_SUB, couponFull },
      });
      const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
      expect(stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect(stripeClient.subscriptionItems.create.mock.calls[0][0]).toMatchObject({
        subscription: "sub_t1",
        quantity: 1,
        proration_behavior: "create_prorations",
        price_data: { unit_amount: 1200 },
      });
      expect(tenantAddon.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ stripeItemId: "si_new", priceSnapshot: 12 }),
        }),
      );
      expect(enabledDeltas(events)).toEqual([12]);
      expect(res.billing).toBe("STRIPE");
      expect(await svc.addonBillingMode("t1")).toBe("STRIPE");
    },
  );

  it("couponFull=false: a quantity raise on an unbilled legacy row of a Stripe tenant is still refused", async () => {
    const { svc, stripeClient } = make({
      sub: { ...STRIPE_SUB, couponFull: false },
      addonRow: ROW,
    });
    const err: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("couponFull=false on an annual Stripe subscription still refuses (the annual rule is unchanged)", async () => {
    const { svc } = make({
      sub: { ...STRIPE_SUB, couponFull: false, billingInterval: "year", cycle: "ANNUAL" },
    });
    expect(await svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100")).not.toBeNull();
  });
});

describe("B1079 C - couponFull without a live Stripe subscription: the mode is unchanged", () => {
  it("a manually-invoiced (externalPayment) tenant is still MANUAL: catalog price, revenue booked, one notice", async () => {
    const { svc, stripeClient, tx, events } = make({
      sub: {
        ...STRIPE_SUB,
        stripeSubId: null,
        stripeCustomerId: null,
        externalPayment: true,
        couponFull: true, // never written alongside externalPayment (coupon-state) - the pin is that it is ignored here
      },
    });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(res.billing).toBe("MANUAL");
    expect(enabledDeltas(events)).toEqual([12]);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(await svc.addonBillingMode("t1")).toBe("MANUAL");
  });

  it("a free pilot (no stripeSubId, no externalPayment) is still UNBILLED", async () => {
    const { svc, stripeClient, getRow } = make({
      sub: { ...STRIPE_SUB, stripeSubId: null, couponFull: true },
    });
    const res: any = await svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(res.billing).toBe("UNBILLED");
    expect(getRow()).toMatchObject({ active: true, priceSnapshot: 0 });
  });
});

describe("B1079 D - disable on a couponFull tenant", () => {
  const sub = { ...STRIPE_SUB, couponFull: true };

  it("an unbilled row is turned off with no Stripe call and no revenue reversed", async () => {
    const { svc, stripeClient, getRow, events } = make({ sub, addonRow: ROW });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({ active: false, stripeItemId: null });
    // a $0 row reverses nothing (the audit record is not a ledger event)
    expect(
      events.emit.mock.calls.filter((c: any[]) => c[1] !== "addon.state_changed"),
    ).toHaveLength(0);
  });

  it("a row that ALREADY carries a Stripe item (billed before the coupon) still has it removed - nothing keeps billing", async () => {
    const { svc, stripeClient, getRow } = make({
      sub,
      addonRow: { ...ROW, priceSnapshot: 12, stripeItemId: "si_1" },
    });
    await svc.disableAddon("t1", "CUSTOMER_PACK_100", "u1");
    expect(stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_1", {
      proration_behavior: "create_prorations",
    });
    expect(getRow()).toMatchObject({ active: false, stripeItemId: null });
  });
});
