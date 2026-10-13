/**
 * DB-lane spec for #2440 (SA-450 + SA-461), against real Postgres: Stripe subscription upkeep.
 *
 * A Prisma mock accepts any `updateMany` filter, so the compare-and-swaps that carry SA-450 are
 * only proven here: the lookup by `stripeSubId` + customer, ACTIVE → CANCELLED booking the −MRR
 * row exactly once, SUSPENDED → CANCELLED booking nothing, TRIAL never forced, `past_due` writing
 * no status, and payment_failed counting + linking the billing portal. SA-461: the price sync
 * refuses (`no_base_item`) when every Stripe item is a known add-on.
 *
 * `BillingService` is constructed directly with REAL `PrismaClient` + `BillingEventService`, and
 * stand-ins only for Stripe, email and the notification/plan-transition collaborators. Every
 * event goes through the public `handleWebhookEvent` dispatcher; the sync through the public
 * `syncStripeSubscriptionPrice`. Stripe ids carry this run's id, so no pre-existing row matches.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("BillingService — #2440 subscription upkeep, real Postgres (SA-450/SA-461)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: BillingService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const PORTAL_URL = "https://billing.stripe.test/p/session_2440";

  const stripe = {
    isConfigured: true,
    getSubscription: jest.fn(),
    // SA-736r: the coupon sync's two Stripe reads - inert (no discount; no upcoming invoice -> nothing written).
    retrieveSubscriptionWithDiscounts: jest
      .fn()
      .mockResolvedValue({ status: "active", discounts: [] }),
    previewNextInvoice: jest.fn().mockResolvedValue(null),
    updateSubscription: jest.fn().mockResolvedValue({}),
    createBillingPortalSession: jest.fn(),
    client: { products: { create: jest.fn() } },
  };
  const email = { send: jest.fn().mockResolvedValue({}) };
  const pricing = {
    checkoutPriceData: jest.fn().mockResolvedValue({
      currency: "usd",
      product_data: { name: "RouteFlow Starter — monthly" },
      unit_amount: 34900,
      recurring: { interval: "month" },
    }),
    resolveTenantPricing: jest
      .fn()
      // Equal to the fixture snapshot (349), so the sync's ledger reconcile books nothing.
      .mockResolvedValue({ planKey: "STARTER", monthly: 349, annual: 3490 }),
  };
  const billingNotification = {
    notifyCancelled: jest.fn().mockResolvedValue(undefined),
    notifySuspended: jest.fn().mockResolvedValue(undefined),
  };
  const planTransition = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    svc = new BillingService(
      prisma as any,
      stripe as any,
      email as any,
      { invalidate: jest.fn() } as any, // tenantStatusGuard
      new BillingEventService(prisma as any),
      pricing as any,
      billingNotification as any,
      planTransition as any,
      {
        checkoutAddonLines: async () => ({ lineItems: [], skus: [], invalid: [] }),
        adoptCheckoutAddons: async () => undefined,
      } as any, // mutations (SA-690)
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stripe.createBillingPortalSession.mockResolvedValue({ url: PORTAL_URL });
    stripe.updateSubscription.mockResolvedValue({});
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma.$disconnect();
    await pool.end();
  });

  /** A PRODUCTION tenant on STARTER at $349 with a Stripe subscription `sub_<run>_<tag>`. */
  async function makeTenant(tag: string, status: TenantStatus) {
    const slug = assertTestTenant(`qa-b2440-${tag}-${run}`, "subscription-upkeep-2440.db.spec.ts");
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status },
    });
    tenantIds.push(tenant.id);
    const ids = { subId: `sub_${run}_${tag}`, customerId: `cus_${run}_${tag}` };
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "STARTER",
        basePriceSnapshot: 349,
        discount: 0,
        stripeSubId: ids.subId,
        stripeCustomerId: ids.customerId,
      },
    });
    return { tenantId: tenant.id, ...ids };
  }

  const deliver = (type: string, object: unknown) =>
    svc.handleWebhookEvent({ id: `evt_${randomUUID()}`, type, data: { object } });

  const statusOf = async (tenantId: string) =>
    (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status;

  const cancelRows = (tenantId: string) =>
    prisma.billingEvent.findMany({
      where: { tenantId, type: BILLING_EVENTS.SUBSCRIPTION_CANCELED },
    });

  it("SA-450 (1): deleted carrying ANOTHER tenant's subscription id ⇒ no-op for both tenants", async () => {
    const a = await makeTenant("own-a", TenantStatus.ACTIVE);
    const b = await makeTenant("own-b", TenantStatus.ACTIVE);

    // Tenant A's subscription id with tenant B's customer: the id matches A's row, but the
    // customer does not — never a write to either tenant.
    await deliver("customer.subscription.deleted", { id: a.subId, customer: b.customerId });

    expect(await statusOf(a.tenantId)).toBe("ACTIVE");
    expect(await statusOf(b.tenantId)).toBe("ACTIVE");
    expect(
      await prisma.billingEvent.count({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } }),
    ).toBe(0);
  });

  it("SA-450 (2): a TRIAL tenant's subscription deleted ⇒ still TRIAL, nothing booked", async () => {
    const t = await makeTenant("trial", TenantStatus.TRIAL);

    await deliver("customer.subscription.deleted", { id: t.subId, customer: t.customerId });

    expect(await statusOf(t.tenantId)).toBe("TRIAL");
    expect(await prisma.billingEvent.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("SA-450 (2): ACTIVE ⇒ CANCELLED exactly once across duplicate webhooks — one −MRR row", async () => {
    const t = await makeTenant("active", TenantStatus.ACTIVE);
    const evt = { id: t.subId, customer: t.customerId };

    await deliver("customer.subscription.deleted", evt);
    await deliver("customer.subscription.deleted", evt);

    expect(await statusOf(t.tenantId)).toBe("CANCELLED");
    const rows = await cancelRows(t.tenantId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountDelta)).toBe(-349);
  });

  it("SA-450 (2): SUSPENDED ⇒ CANCELLED with NO second −MRR (suspension already removed it)", async () => {
    const t = await makeTenant("suspended", TenantStatus.SUSPENDED);

    await deliver("customer.subscription.deleted", { id: t.subId, customer: t.customerId });

    expect(await statusOf(t.tenantId)).toBe("CANCELLED");
    expect(await prisma.billingEvent.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("SA-450 (3): updated with status past_due ⇒ no status write, nothing booked", async () => {
    const t = await makeTenant("pastdue", TenantStatus.ACTIVE);

    await deliver("customer.subscription.updated", {
      id: t.subId,
      customer: t.customerId,
      status: "past_due",
      cancel_at_period_end: false,
    });

    expect(await statusOf(t.tenantId)).toBe("ACTIVE");
    expect(await prisma.billingEvent.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("SA-450 (4): payment_failed ⇒ failedPaymentCount 1, status unchanged, email carries the portal URL", async () => {
    const t = await makeTenant("failed", TenantStatus.ACTIVE);
    await prisma.user.create({
      data: {
        email: `qa-b2440-${run}@example.invalid`,
        username: `qa-b2440-${run}`,
        role: "TENANT_ADMIN",
        tenantId: t.tenantId,
      },
    });

    await deliver("invoice.payment_failed", {
      customer: t.customerId,
      parent: { subscription_details: { subscription: t.subId } },
    });

    const sub = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: t.tenantId },
    });
    expect(sub.failedPaymentCount).toBe(1);
    expect(await statusOf(t.tenantId)).toBe("ACTIVE");
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].html).toContain(PORTAL_URL);
  });

  it("SA-450 (4): a billing-portal failure still sends the email, with the fallback text", async () => {
    const t = await makeTenant("portal-down", TenantStatus.ACTIVE);
    await prisma.user.create({
      data: {
        email: `qa-b2440-pd-${run}@example.invalid`,
        username: `qa-b2440-pd-${run}`,
        role: "TENANT_ADMIN",
        tenantId: t.tenantId,
      },
    });
    stripe.createBillingPortalSession.mockRejectedValue(new Error("portal down"));

    await deliver("invoice.payment_failed", {
      customer: t.customerId,
      parent: { subscription_details: { subscription: t.subId } },
    });

    const sub = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: t.tenantId },
    });
    expect(sub.failedPaymentCount).toBe(1);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].html).toContain("contacting support");
    expect(email.send.mock.calls[0][0].html).not.toContain(PORTAL_URL);
  });

  it("SA-461: every Stripe item a known add-on ⇒ the price sync returns no_base_item and writes nothing", async () => {
    const t = await makeTenant("addon-only", TenantStatus.ACTIVE);
    const addonItemId = `si_${run}_addon`;
    await prisma.tenantAddon.create({
      data: {
        tenantId: t.tenantId,
        addonKey: "customer_pack_100",
        priceSnapshot: 25,
        stripeItemId: addonItemId,
      },
    });
    stripe.getSubscription.mockResolvedValue({
      id: t.subId,
      status: "active",
      items: {
        data: [
          { id: addonItemId, price: { recurring: { interval: "month" }, product: "prod_addon" } },
        ],
      },
    });

    const result = await svc.syncStripeSubscriptionPrice(t.tenantId);

    expect(result).toEqual({ synced: false, reason: "no_base_item" });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(await prisma.billingEvent.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });
});
