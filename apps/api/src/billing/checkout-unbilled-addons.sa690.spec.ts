// `@LeaderCron` wraps every cron tick in a Postgres advisory lock; these specs never tick a cron, but
// importing BillingService loads the module, so the lock is the same pass-through billing.service.spec uses.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { ConflictException } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { SettingsBillingController } from "./settings-billing.controller";
import { PlatformAdminController } from "../platform-admin/platform-admin.controller";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-690 interim gate: `BillingService.createCheckoutSession` refuses (a coded 409) while the tenant
 * has an ACTIVE self-serve add-on row that no Stripe subscription item bills (`stripeItemId` null).
 * A checkout would otherwise turn the tenant into a paying subscriber whose add-on is never invoiced.
 * Both entry points (the tenant's own settings→billing checkout and the platform-admin link) call the
 * ONE service method, so the check lives there and each controller is proven to reach it.
 */

const BLOCK = "ADDON_BILLING_PENDING_CHECKOUT";

type Row = {
  tenantId: string;
  addonKey: string;
  sku: string | null;
  active: boolean;
  stripeItemId: string | null;
  /** SA-693: a platform comp is never billed and never blocks a checkout. */
  isComp?: boolean;
  createdAt?: Date;
};

const row = (over: Partial<Row> & { sku: string }): Row => ({
  tenantId: "t1",
  addonKey: over.sku,
  active: true,
  stripeItemId: null,
  ...over,
});

const CATALOG = [
  { sku: "CUSTOMER_PACK_100", name: "Customer Pack 100" },
  { sku: "FORECASTING", name: "Forecasting" },
  { sku: "REGULATED_ITEMS", name: "Regulated Items" },
];

/** Applies exactly the `where` keys the gate is allowed to use; any other key fails loudly. */
function matchRow(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "tenantId") {
      if (r.tenantId !== v) return false;
    } else if (k === "active") {
      if (r.active !== v) return false;
    } else if (k === "isComp") {
      if ((r.isComp ?? false) !== v) return false;
    } else if (k === "stripeItemId") {
      if (v !== null) throw new Error(`mock cannot evaluate stripeItemId: ${String(v)}`);
      if (r.stripeItemId !== null) return false;
    } else {
      throw new Error(`mock cannot evaluate where.${k}`);
    }
  }
  return true;
}

function make(addons: Row[] = []) {
  const sessionCreate = jest
    .fn()
    .mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
  const stripe = {
    isConfigured: true,
    createCustomer: jest.fn().mockResolvedValue({ id: "cus_new" }),
    getSubscription: jest.fn(),
    client: { checkout: { sessions: { create: sessionCreate } } },
  } as any;
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        id: "t1",
        slug: "acme",
        name: "Acme",
        subscription: { stripeCustomerId: "cus_1" },
        config: { businessName: "Acme" },
      }),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    tenantAddon: {
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        addons.filter((r) => matchRow(r, args.where)),
      ),
    },
    addonSku: {
      findMany: jest.fn(async (args: { where: { sku: { in: string[] } } }) =>
        CATALOG.filter((c) => args.where.sku.in.includes(c.sku)),
      ),
    },
  } as any;
  const pricing = {
    resolveTenantPricing: jest.fn().mockResolvedValue({ planKey: "STARTER" }),
    checkoutPriceData: jest.fn().mockResolvedValue({
      currency: "usd",
      unit_amount: 9900,
      recurring: { interval: "month" },
      product_data: { name: "RouteFlow Starter" },
    }),
  } as any;
  const svc = new BillingService(
    prisma,
    stripe,
    {} as any,
    {} as any,
    {} as any,
    pricing,
    {} as any,
    {} as any,
  );
  return { svc, prisma, stripe, sessionCreate };
}

async function refusalOf(p: Promise<unknown>): Promise<ConflictException> {
  try {
    await p;
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error("expected the checkout to be refused, but it resolved");
}

describe("SA-690 createCheckoutSession refuses while self-serve add-ons are unbilled", () => {
  it("pins the wire code", () => {
    expect(API_ERROR_CODES.ADDON_BILLING_PENDING_CHECKOUT).toBe(BLOCK);
  });

  it("(1) refuses with one active unbilled self-serve add-on: coded 409, its name, no Stripe checkout", async () => {
    const { svc, sessionCreate, stripe } = make([row({ sku: "FORECASTING" })]);

    const err = await refusalOf(svc.createCheckoutSession("t1", "month"));

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: BLOCK,
      message: "Turn off Forecasting before adding your card, or contact support to set them up.",
    });
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it("(1b) joins two add-on names naturally and never says pilot", async () => {
    const { svc, sessionCreate } = make([
      row({ sku: "CUSTOMER_PACK_100" }),
      row({ sku: "FORECASTING" }),
    ]);

    const err = await refusalOf(svc.createCheckoutSession("t1", { interval: "year" }));

    const body = err.getResponse() as { code: string; message: string };
    expect(body.code).toBe(BLOCK);
    expect(body.message).toBe(
      "Turn off Customer Pack 100 and Forecasting before adding your card, or contact support to set them up.",
    );
    expect(body.message).not.toMatch(/pilot/i);
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it("(1c) a duplicate row for one SKU names it once", async () => {
    const { svc } = make([
      row({ sku: "FORECASTING" }),
      row({ sku: "FORECASTING", addonKey: "forecasting_legacy_dupe" }),
    ]);

    const err = await refusalOf(svc.createCheckoutSession("t1", "month"));

    expect((err.getResponse() as { message: string }).message).toBe(
      "Turn off Forecasting before adding your card, or contact support to set them up.",
    );
  });

  it("SA-693: a comp row passes the gate (never blocks), through the same method both entry points reach", async () => {
    const { svc, sessionCreate } = make([row({ sku: "FORECASTING", isComp: true })]);

    await expect(svc.createCheckoutSession("t1", "month")).resolves.toEqual({
      checkoutUrl: "https://checkout.stripe.test/cs_1",
      sessionId: "cs_1",
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it("SA-693: a comp does not mask a real unbilled row � only the non-comp one is named", async () => {
    const { svc, sessionCreate } = make([
      row({ sku: "FORECASTING", isComp: true }),
      row({ sku: "CUSTOMER_PACK_100", isComp: false }),
    ]);

    const err = await refusalOf(svc.createCheckoutSession("t1", "month"));

    expect((err.getResponse() as { message: string }).message).toBe(
      "Turn off Customer Pack 100 before adding your card, or contact support to set them up.",
    );
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it("(2) allows the checkout when the tenant has no add-ons", async () => {
    const { svc, sessionCreate, prisma } = make([]);

    const out = await svc.createCheckoutSession("t1", "month");

    expect(out).toEqual({
      checkoutUrl: "https://checkout.stripe.test/cs_1",
      sessionId: "cs_1",
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(prisma.addonSku.findMany).not.toHaveBeenCalled();
  });

  it("(3) allows the checkout when every active add-on is billed through a Stripe item", async () => {
    const { svc, sessionCreate } = make([
      row({ sku: "FORECASTING", stripeItemId: "si_forecasting" }),
      row({ sku: "CUSTOMER_PACK_100", stripeItemId: "si_pack" }),
    ]);

    await expect(svc.createCheckoutSession("t1", "month")).resolves.toMatchObject({
      sessionId: "cs_1",
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it("(4) an INACTIVE unbilled row does not block", async () => {
    const { svc, sessionCreate } = make([row({ sku: "FORECASTING", active: false })]);

    await expect(svc.createCheckoutSession("t1", "month")).resolves.toMatchObject({
      sessionId: "cs_1",
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it("(5) an unbilled row of an admin-granted (not self-serve) SKU does not block", async () => {
    const { svc, sessionCreate } = make([
      row({ sku: "REGULATED_ITEMS", addonKey: "tobacco_dealer" }),
    ]);

    await expect(svc.createCheckoutSession("t1", "month")).resolves.toMatchObject({
      sessionId: "cs_1",
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it("(6) another tenant's unbilled add-on does not block this tenant", async () => {
    const { svc } = make([row({ sku: "FORECASTING", tenantId: "t2" })]);

    await expect(svc.createCheckoutSession("t1", "month")).resolves.toMatchObject({
      sessionId: "cs_1",
    });
  });
});

describe("SA-690 both checkout entry points reach the gate", () => {
  it("settings→billing createCheckout (tenant's own checkout) is refused with the coded 409", async () => {
    const { svc, sessionCreate } = make([row({ sku: "CUSTOMER_PACK_100" })]);
    const subscription = { getSubscription: jest.fn().mockResolvedValue({ planKey: "STARTER" }) };
    const controller = new SettingsBillingController(
      subscription as any,
      {} as any,
      {} as any,
      svc,
    );

    const err = await refusalOf(controller.createCheckout({ tenantId: "t1", sub: "u1" } as any));

    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: BLOCK,
      message:
        "Turn off Customer Pack 100 before adding your card, or contact support to set them up.",
    });
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it("platform-admin createCheckout (admin link) is refused with the coded 409", async () => {
    const { svc, sessionCreate } = make([row({ sku: "FORECASTING" })]);
    const controller = new PlatformAdminController(
      {} as any,
      {} as any,
      svc,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const err = await refusalOf(controller.createCheckout("t1", "year"));

    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: BLOCK,
      message: "Turn off Forecasting before adding your card, or contact support to set them up.",
    });
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it("with no unbilled add-on both entry points still mint a session (the gate is not a blanket refusal)", async () => {
    const { svc, sessionCreate } = make([]);
    const subscription = { getSubscription: jest.fn().mockResolvedValue({ planKey: "STARTER" }) };
    const settings = new SettingsBillingController(subscription as any, {} as any, {} as any, svc);
    const admin = new PlatformAdminController(
      {} as any,
      {} as any,
      svc,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await settings.createCheckout({ tenantId: "t1", sub: "u1" } as any);
    await admin.createCheckout("t1", "month");

    expect(sessionCreate).toHaveBeenCalledTimes(2);
  });
});
