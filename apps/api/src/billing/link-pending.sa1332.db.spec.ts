/**
 * SA-1332 R1 - the LINKED / UNLINKED audit markers and the price-push hold, against real Postgres.
 *
 * What the in-memory specs cannot prove: the once-per-session check in `writeLinkedMarker` is a Prisma JSON-path query
 * (`meta: { path: ["sessionId"], equals: sessionId }`), and `isLinkPending` reads those rows back. Each case drives the
 * real handler (`onCheckoutCompleted` / `onCheckoutAsyncPaymentFailed`) on a real Prisma client; only Stripe is a stub.
 * Redeliveries are delivered by calling the handler directly, so the webhook event ledger can never stop them before the
 * JSON-path lookup runs. Throwaway `qa-*` tenants (assertTestTenant), every row removed in afterAll.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  withAdvisoryLocks: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingEventService } from "./billing-event.service";
import { isLinkPending } from "./link-pending";
import {
  STRIPE_CHECKOUT_APPLIED_ACTION,
  STRIPE_CHECKOUT_ENTITY,
  STRIPE_CHECKOUT_LINK_ENTITY,
  STRIPE_CHECKOUT_LINKED_ACTION,
  STRIPE_CHECKOUT_UNLINKED_ACTION,
} from "./config-snapshot-audit.constants";
import { buildCheckoutHarness } from "../testing/checkout-completed-harness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "link-pending.sa1332.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb("SA-1332 R1: the checkout link marker and the price-push hold (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  /** What the Stripe stub answers `getSubscription` with, by subscription id (set per tenant). */
  const stripeSubs = new Map<string, any>();
  const stripe: any = {
    isConfigured: true,
    client: {},
    getSubscription: jest.fn(async (id: string) => stripeSubs.get(id)),
    updateSubscription: jest.fn(),
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingNotificationLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  beforeEach(() => {
    stripe.getSubscription.mockClear();
    stripe.updateSubscription.mockClear();
  });

  /** A TRIAL tenant with a Stripe customer on file (the checkout's customer check needs it), and no subscription yet. */
  async function trialTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa1332-${run}-${seq}-${label}`, SPEC);
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.TRIAL },
    });
    tenantIds.push(tenant.id);
    const customer = `cus_sa1332_${run}_${seq}`;
    const subId = `sub_sa1332_${run}_${seq}`;
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "GROWTH",
        basePriceSnapshot: 249,
        discount: 0,
        cycle: "MONTHLY",
        periodStart: new Date(Date.now() - 2 * DAY),
        periodEnd: new Date(Date.now() + 12 * DAY),
        externalPayment: false,
        stripeCustomerId: customer,
      },
    });
    stripeSubs.set(subId, {
      id: subId,
      status: "incomplete",
      customer,
      metadata: {},
      items: {
        data: [
          {
            id: `si_base_${run}_${seq}`,
            quantity: 1,
            current_period_start: Math.floor((Date.now() - 2 * DAY) / 1000),
            current_period_end: Math.floor((Date.now() + 28 * DAY) / 1000),
            price: { unit_amount: 24900, product: { name: "Growth" } },
          },
        ],
      },
    });
    const harness = buildCheckoutHarness({
      prisma,
      catalog: {},
      stripe,
      events: new BillingEventService(prisma as any),
    });
    const session = (n: number, payment_status: "unpaid" | "paid") => ({
      id: `cs_sa1332_${run}_${seq}_${n}`,
      customer,
      subscription: subId,
      payment_status,
      created: Math.floor(Date.now() / 1000),
      metadata: { tenantId: tenant.id }, // no planKey: the plain link, no plan-move machinery
    });
    return { tenantId: tenant.id, subId, harness, session };
  }

  const handler = (h: { billing: unknown }, name: string, session: unknown): Promise<void> =>
    (h.billing as any)[name](session);
  const markers = (tenantId: string, action: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, entityType: STRIPE_CHECKOUT_LINK_ENTITY, action },
    });
  const pending = (tenantId: string, subId: string) =>
    isLinkPending(prisma as any, tenantId, subId);

  it("D1 an UNPAID bank-debit completion writes exactly one LINKED row and the subscription is link-pending", async () => {
    const t = await trialTenant("d1");
    const unpaid = t.session(1, "unpaid");

    await t.harness.complete(unpaid);

    const linked = await markers(t.tenantId, STRIPE_CHECKOUT_LINKED_ACTION);
    expect(linked).toHaveLength(1);
    expect(linked[0].entityType).toBe(STRIPE_CHECKOUT_LINK_ENTITY);
    expect(linked[0].entityId).toBe(t.subId);
    expect(linked[0].meta).toMatchObject({ sessionId: unpaid.id, trialAtLink: true });
    expect(
      (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } }))
        .stripeSubId,
    ).toBe(t.subId);
    expect(await pending(t.tenantId, t.subId)).toBe(true);
  }, 90_000);

  it("D2 a redelivery of the SAME unpaid session (handler called directly) leaves ONE LINKED row", async () => {
    const t = await trialTenant("d2");
    const unpaid = t.session(1, "unpaid");
    await t.harness.complete(unpaid);

    await handler(t.harness, "onCheckoutCompleted", unpaid);
    await handler(t.harness, "onCheckoutCompleted", unpaid);

    expect(
      await prisma.auditLog.count({
        where: {
          tenantId: t.tenantId,
          entityType: STRIPE_CHECKOUT_LINK_ENTITY,
          entityId: t.subId,
          action: STRIPE_CHECKOUT_LINKED_ACTION,
        },
      }),
    ).toBe(1);
    expect(await pending(t.tenantId, t.subId)).toBe(true);
  }, 90_000);

  it("D3 a second, DIFFERENT unpaid session on the same subscription writes its own LINKED row", async () => {
    const t = await trialTenant("d3");
    const first = t.session(1, "unpaid");
    const second = t.session(2, "unpaid");

    await t.harness.complete(first);
    await handler(t.harness, "onCheckoutCompleted", second);

    const linked = await markers(t.tenantId, STRIPE_CHECKOUT_LINKED_ACTION);
    expect(linked).toHaveLength(2);
    expect(linked.map((r) => (r.meta as { sessionId: string }).sessionId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(linked.every((r) => r.entityId === t.subId)).toBe(true);
  }, 90_000);

  it("D4 the settled delivery of the same session writes the APPLIED row and the link is no longer pending", async () => {
    const t = await trialTenant("d4");
    const unpaid = t.session(1, "unpaid");
    await t.harness.complete(unpaid);
    expect(await pending(t.tenantId, t.subId)).toBe(true);

    await handler(t.harness, "onCheckoutCompleted", { ...unpaid, payment_status: "paid" });

    expect(
      await prisma.auditLog.count({
        where: {
          tenantId: t.tenantId,
          entityType: STRIPE_CHECKOUT_ENTITY,
          entityId: unpaid.id,
          action: STRIPE_CHECKOUT_APPLIED_ACTION,
        },
      }),
    ).toBe(1);
    expect(await markers(t.tenantId, STRIPE_CHECKOUT_LINKED_ACTION)).toHaveLength(1);
    expect(await pending(t.tenantId, t.subId)).toBe(false);
  }, 90_000);

  it("D5 a failed bank debit on a pending link writes one UNLINKED row; a second failure adds none", async () => {
    const t = await trialTenant("d5");
    const unpaid = t.session(1, "unpaid");
    await t.harness.complete(unpaid);
    expect(await pending(t.tenantId, t.subId)).toBe(true);

    await handler(t.harness, "onCheckoutAsyncPaymentFailed", unpaid);

    const unlinked = await markers(t.tenantId, STRIPE_CHECKOUT_UNLINKED_ACTION);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].entityId).toBe(t.subId);
    expect(unlinked[0].meta).toMatchObject({
      sessionId: unpaid.id,
      reason: "async_payment_failed",
    });
    expect(await pending(t.tenantId, t.subId)).toBe(false);

    await handler(t.harness, "onCheckoutAsyncPaymentFailed", unpaid);

    expect(await markers(t.tenantId, STRIPE_CHECKOUT_UNLINKED_ACTION)).toHaveLength(1);
    expect(await pending(t.tenantId, t.subId)).toBe(false);
  }, 90_000);

  it("D6 while the link is pending the price push returns subscription_link_pending and never calls Stripe", async () => {
    const t = await trialTenant("d6");
    await t.harness.complete(t.session(1, "unpaid"));
    expect(await pending(t.tenantId, t.subId)).toBe(true);
    stripe.getSubscription.mockClear(); // the completion itself read the subscription: count only the push

    const result = await t.harness.billing.pushResolvedPriceToStripe(t.tenantId);

    expect(result).toEqual({ synced: false, reason: "subscription_link_pending" });
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  }, 90_000);
});
