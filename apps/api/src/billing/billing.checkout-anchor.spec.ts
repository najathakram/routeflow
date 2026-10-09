import { BillingService } from "./billing.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-733 D6 / M6 at the service boundary: what `createCheckoutSession` sends to Stripe. Stripe is MOCKED (the
 * `client.checkout.sessions.create` jest.fn); nothing here can reach a real account.
 */

const ONLY_DATE: any[] = [
  "nextTick",
  "setImmediate",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "performance",
  "hrtime",
];

function make(opts: { addonSkus?: string[] } = {}) {
  const create = jest.fn().mockResolvedValue({ id: "cs_1", url: "https://pay.test" });
  const stripe: any = {
    isConfigured: true,
    client: { checkout: { sessions: { create } } },
    getSubscription: jest.fn(),
  };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        slug: "acme",
        name: "Acme",
        subscription: { stripeCustomerId: "cus_1" },
        config: { businessName: "Acme" },
      })),
    },
    tenantSubscription: { findUnique: jest.fn(async () => ({ stripeSubId: null })) },
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({
      lineItems: (opts.addonSkus ?? []).map((sku) => ({ price_data: { sku }, quantity: 1 })),
      skus: opts.addonSkus ?? [],
    })),
  };
  const pricing: any = {
    resolveTenantPricing: jest.fn().mockResolvedValue({ planKey: "STARTER" }),
    checkoutPriceData: jest.fn(async (_t: string, interval: string) => ({
      currency: "usd",
      product_data: { name: "RouteFlow Starter" },
      unit_amount: 9900,
      recurring: { interval },
    })),
  };
  const billing = new BillingService(
    prisma,
    stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    pricing,
    {} as any,
    {} as any,
    mutations,
  );
  return { billing, create, stripe, mutations };
}

const sent = (h: ReturnType<typeof make>) => h.create.mock.calls[0][0];
const at = (iso: string) => Date.parse(iso) / 1000;

afterEach(() => jest.useRealTimers());

describe("SA-733 D6 / M6 — createCheckoutSession anchors every new subscription", () => {
  it.each([
    ["Oct 15", "2026-10-15T09:00:00Z", "2026-11-01T12:00:00Z"],
    ["Oct 31 23:00Z", "2026-10-31T23:00:00Z", "2026-11-01T12:00:00Z"],
    ["Dec 15 (year roll)", "2026-12-15T09:00:00Z", "2027-01-01T12:00:00Z"],
    [
      "on the 1st (afternoon): never an omitted anchor",
      "2026-11-01T15:00:00Z",
      "2026-12-01T12:00:00Z",
    ],
  ])("%s: billing_cycle_anchor + create_prorations", async (_n, now, anchor) => {
    jest.useFakeTimers({ now: new Date(now), doNotFake: ONLY_DATE });
    const h = make();
    await h.billing.createCheckoutSession("t1", "month");
    expect(sent(h).mode).toBe("subscription");
    expect(sent(h).subscription_data).toEqual({
      billing_cycle_anchor: at(anchor),
      proration_behavior: "create_prorations",
    });
  });

  it("Oct 31 23:00Z: the session expires BEFORE the anchor (<= 11:00Z), so it cannot complete after it", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-31T23:00:00Z"), doNotFake: ONLY_DATE });
    const h = make();
    await h.billing.createCheckoutSession("t1", "month");
    expect(sent(h).expires_at).toBeLessThanOrEqual(at("2026-11-01T11:00:00Z"));
    expect(sent(h).expires_at).toBeGreaterThan(at("2026-10-31T23:00:00Z") + 30 * 60);
  });

  it("Oct 15: the session lives the plain 24 h", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z"), doNotFake: ONLY_DATE });
    const h = make();
    await h.billing.createCheckoutSession("t1", "month");
    expect(sent(h).expires_at).toBe(at("2026-10-16T09:00:00Z"));
  });

  it("add-on SKUs still ride subscription_data.metadata beside the anchor", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z"), doNotFake: ONLY_DATE });
    const h = make({ addonSkus: ["FORECASTING"] });
    await h.billing.createCheckoutSession("t1", "month");
    expect(sent(h).subscription_data).toEqual({
      billing_cycle_anchor: at("2026-11-01T12:00:00Z"),
      proration_behavior: "create_prorations",
      metadata: { tenantId: "t1", addonSkus: "FORECASTING" },
    });
  });

  it("never sends the combinations Checkout rejects: no trial with an anchor, no one-time line with proration none", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z"), doNotFake: ONLY_DATE });
    const h = make();
    await h.billing.createCheckoutSession("t1", "month");
    const sd = sent(h).subscription_data;
    expect(sd).not.toHaveProperty("trial_end");
    expect(sd).not.toHaveProperty("trial_period_days");
    expect(sd.proration_behavior).not.toBe("none");
    for (const li of sent(h).line_items) expect(li.price_data.recurring).toBeDefined();
  });

  it("annual is refused (monthly only) with its own code, before any customer or session is created", async () => {
    const h = make();
    const err: any = await h.billing.createCheckoutSession("t1", "year").catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.CHECKOUT_ANNUAL_NOT_SUPPORTED,
    });
    expect(h.create).not.toHaveBeenCalled();
  });
});
