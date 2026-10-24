/**
 * M11 (SA fail on #3441): the self-serve enable body's `quantity` is the TARGET total, so a page that
 * showed a stale owned count could CUT a pack (owned 6, page showed 2, "buy 1" -> target 3). The fix is a
 * compare-and-set: `expectedQuantity` is read against the stored quantity UNDER the existing add-on
 * advisory lock, before any Stripe call. Also pinned here: a buy-more never reduces, a one-per-workspace
 * SKU refuses a quantity above 1, and raising an active row no Stripe item bills is a coded 409.
 *
 * Stripe is the module-boundary double (`StripeService`); no live Stripe.
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

import { SubscriptionMutationService } from "./subscription-mutation.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

const CATALOG = {
  addonSkus: [
    { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 50, stackable: true },
    { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19, stackable: false },
  ],
  definitions: [],
};
const STRIPE_SUB = {
  tenantId: "t1",
  stripeSubId: "sub_t1",
  stripeCustomerId: "cus_t1",
  billingInterval: "month",
  cycle: "MONTHLY",
};

function make(addonRow: Record<string, unknown> | null) {
  let row: any = addonRow && { ...addonRow };
  const tenantAddon = {
    findFirst: jest.fn(async () => (row ? { ...row } : null)),
    findUnique: jest.fn(async () => (row ? { ...row } : null)),
    upsert: jest.fn(async ({ create, update }: any) => {
      row = row
        ? { ...row, ...update, id: row.id ?? "a1" }
        : { id: "a1", addonKey: create.addonKey, ...create };
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
      findUnique: jest.fn().mockResolvedValue({ slug: "acme", name: "Acme", plan: "STARTER" }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(STRIPE_SUB) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
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
  const svc = new SubscriptionMutationService(
    prisma,
    { getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG) } as any,
    { prorationPreview: jest.fn().mockResolvedValue({ proratedToday: 1 }) } as any,
    { getSubscription: jest.fn().mockResolvedValue({ planKey: "TEAM" }) } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn().mockResolvedValue({}) } as any,
    { invalidate: jest.fn() } as any,
    { isConfigured: true, client: stripeClient } as any,
    { notifyUpgradeConfirmed: jest.fn(), notifyDowngradeScheduled: jest.fn() } as any,
    { prepare: jest.fn(), onPlanChange: jest.fn() } as any,
  );
  const stripeCalls = () =>
    stripeClient.subscriptionItems.create.mock.calls.length +
    stripeClient.subscriptionItems.update.mock.calls.length +
    stripeClient.subscriptionItems.del.mock.calls.length;
  return { svc, stripeClient, stripeCalls, getRow: () => row, tenantAddon };
}

const OWNED_6 = {
  id: "a1",
  addonKey: "CUSTOMER_PACK_100",
  sku: "CUSTOMER_PACK_100",
  quantity: 6,
  active: true,
  priceSnapshot: 50,
  stripeItemId: "si_1",
  isComp: false,
};

const bodyOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { status: e.getStatus?.(), body: e.getResponse?.() };
  }
  throw new Error("expected a rejection");
};

describe("enableAddon expectedQuantity (M11 compare-and-set under the lock)", () => {
  it("a stale expectedQuantity is a coded 409 and touches NOTHING: no Stripe call, row unchanged", async () => {
    const { svc, stripeCalls, getRow } = make(OWNED_6);
    // The page showed 2, the stored quantity is 6: "buy 1" would target 3 and CUT the pack.
    const out = await bodyOf(svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1", 2));
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ code: API_ERROR_CODES.ADDON_QUANTITY_CHANGED });
    expect(stripeCalls()).toBe(0);
    expect(getRow().quantity).toBe(6);
  });

  it("a stale expectedQuantity of 0 against an active row is also refused", async () => {
    const { svc, stripeCalls } = make(OWNED_6);
    const out = await bodyOf(svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1", 0));
    expect(out.body).toMatchObject({ code: API_ERROR_CODES.ADDON_QUANTITY_CHANGED });
    expect(stripeCalls()).toBe(0);
  });

  it("a matching expectedQuantity goes through: one Stripe update to the new total", async () => {
    const { svc, stripeClient, getRow } = make(OWNED_6);
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 7, "u1", 6);
    expect(stripeClient.subscriptionItems.update).toHaveBeenCalledTimes(1);
    expect(stripeClient.subscriptionItems.update).toHaveBeenCalledWith(
      "si_1",
      expect.objectContaining({ quantity: 7 }),
    );
    expect(getRow().quantity).toBe(7);
  });

  it("a first purchase (expectedQuantity 0, no row) goes through at the chosen quantity", async () => {
    const { svc, stripeClient, getRow } = make(null);
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1", 0);
    expect(stripeClient.subscriptionItems.create.mock.calls[0][0]).toMatchObject({ quantity: 3 });
    expect(getRow().quantity).toBe(3);
  });

  it("a buy-more never reduces: a target at or below expectedQuantity is refused before Stripe", async () => {
    for (const target of [3, 6]) {
      const { svc, stripeCalls, getRow } = make(OWNED_6);
      const out = await bodyOf(svc.enableAddon("t1", "CUSTOMER_PACK_100", target, "u1", 6));
      expect(out.body).toMatchObject({ code: API_ERROR_CODES.ADDON_QUANTITY_NOT_INCREASED });
      expect(stripeCalls()).toBe(0);
      expect(getRow().quantity).toBe(6);
    }
  });

  it("without expectedQuantity the legacy contract is unchanged (a lower target still reduces)", async () => {
    const { svc, stripeClient, getRow } = make(OWNED_6);
    await svc.enableAddon("t1", "CUSTOMER_PACK_100", 3, "u1");
    expect(stripeClient.subscriptionItems.update).toHaveBeenCalledTimes(1);
    expect(getRow().quantity).toBe(3);
  });
});

describe("enableAddon guards (M11 SHOULDs)", () => {
  it("a one-per-workspace SKU refuses a quantity above 1 with a coded 400, before any Stripe call", async () => {
    const { svc, stripeCalls } = make(null);
    const out = await bodyOf(svc.enableAddon("t1", "FORECASTING", 2, "u1"));
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: API_ERROR_CODES.ADDON_NOT_STACKABLE });
    expect(stripeCalls()).toBe(0);
  });

  it("a one-per-workspace SKU still enables at quantity 1", async () => {
    const { svc, getRow } = make(null);
    await svc.enableAddon("t1", "FORECASTING", 1, "u1");
    expect(getRow().quantity).toBe(1);
  });

  it("raising an active row that no Stripe item bills is a CODED 409 (ADDON_RAISE_UNBILLED_ROW)", async () => {
    const { svc, stripeCalls } = make({ ...OWNED_6, stripeItemId: null });
    const out = await bodyOf(svc.enableAddon("t1", "CUSTOMER_PACK_100", 7, "u1", 6));
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ code: API_ERROR_CODES.ADDON_RAISE_UNBILLED_ROW });
    expect(stripeCalls()).toBe(0);
  });

  it("the preview refuses the same unbilled row with the same code, so no quote is shown for it", async () => {
    const { svc } = make({ ...OWNED_6, stripeItemId: null });
    await expect(svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100")).resolves.toMatchObject({
      code: API_ERROR_CODES.ADDON_RAISE_UNBILLED_ROW,
    });
  });

  it("the preview does not refuse a Stripe-billed active row", async () => {
    const { svc } = make(OWNED_6);
    await expect(svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100")).resolves.toBeNull();
  });
});
