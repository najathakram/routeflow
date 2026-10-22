/**
 * SA-832 row 453 - real Postgres. ONE predicate decides whether a payment may lift a tenant's lock
 * (`paymentReinstatable` in dunning-config.ts); its CAS twin `paymentReinstatableWhere` rides the status write of the
 * checkout completion and of invoice.payment_succeeded.
 *
 *  1. Parity: for every (status x readOnlyReason) cell, the filter selects exactly the rows the function allows
 *     (SQL three-valued logic: `readOnlyReason <> 'admin_set'` is never true for NULL - the thing a pure-JS spec
 *     cannot prove).
 *  2. The reinstating CAS through the REAL BillingService.transitionAndEmit + transitionToActiveTx: an admin lock
 *     (READ_ONLY admin_set / legacy, SUSPENDED admin_set, CANCELLED) is left alone and books no ledger delta; a
 *     billing lock (trial_expired, payment_overdue, a reason-less SUSPENDED) lifts exactly once.
 *  3. The REAL SubscriptionMutationService.subscribe(): refused with the coded 409 on an admin lock, nothing
 *     written; still converts a lapsed trial.
 * Throwaway `qa-*` tenants, cleaned up. DB lane.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { paymentReinstatable, paymentReinstatableWhere } from "./dunning-config";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const STATUSES = ["ACTIVE", "TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED"] as const;
const REASONS = [
  null,
  "admin_set",
  "trial_expired",
  "trial_cancelled",
  "payment_overdue",
  "subscription_cancelled",
  "overdue_payment",
  "something_new",
] as const;

describeDb("SA-832 / 453 - one payment-reinstatable predicate (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let billing: BillingService;
  let mutations: SubscriptionMutationService;
  let createdVersionId: string | undefined;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const stub = () =>
    new Proxy(
      {},
      { get: (_t, k) => (k === "then" ? undefined : jest.fn().mockResolvedValue(undefined)) },
    ) as any;
  const planTransition = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  } as any;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      { plans: [{ planKey: "STARTER", name: "Starter", monthlyPrice: 99 }], addons: [] },
      "payment-reinstatable.sa832.db.spec.ts",
    );
    const catalog = new PlanCatalogService(prisma as any);
    const events = new BillingEventService(prisma as any);
    billing = new BillingService(
      prisma as any,
      { isConfigured: true } as any,
      { send: async () => ({}) } as any,
      { invalidate: () => undefined } as any,
      events,
      {} as any,
      stub(),
      planTransition,
      { checkoutAddonLines: async () => ({ lineItems: [], skus: [] }) } as any,
    );
    mutations = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
      { invalidate: jest.fn() } as any,
      events,
      stub(),
      stub(),
      stub(),
      planTransition,
    );
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function tenantIn(
    status: string,
    readOnlyReason: string | null,
    withSub = false,
  ): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa832-${run}-${seq}`,
      "payment-reinstatable.sa832.db.spec.ts",
    );
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: slug,
        class: TenantClass.PRODUCTION,
        status: status as TenantStatus,
        readOnlyReason,
      },
    });
    tenantIds.push(t.id);
    if (withSub) {
      await prisma.tenantSubscription.create({
        data: { tenantId: t.id, planKey: "STARTER", basePriceSnapshot: 99, discount: 0 } as any,
      });
    }
    return t.id;
  }
  const row = (id: string) =>
    prisma.tenant.findUniqueOrThrow({
      where: { id },
      select: { status: true, readOnlyReason: true, plan: true },
    });

  it("parity: the CAS filter selects exactly the non-ACTIVE rows paymentReinstatable allows (every status x reason cell)", async () => {
    const cells: Array<{ id: string; status: string; reason: string | null }> = [];
    for (const status of STATUSES) {
      for (const reason of REASONS) {
        cells.push({ id: await tenantIn(status, reason), status, reason });
      }
    }
    const selected = new Set(
      (
        await prisma.tenant.findMany({
          where: {
            id: { in: cells.map((c) => c.id) },
            status: { not: "ACTIVE" },
            ...paymentReinstatableWhere(),
          },
          select: { id: true },
        })
      ).map((t) => t.id),
    );
    for (const c of cells) {
      const expected = c.status !== "ACTIVE" && paymentReinstatable(c.status, c.reason);
      expect({ status: c.status, reason: c.reason, selected: selected.has(c.id) }).toEqual({
        status: c.status,
        reason: c.reason,
        selected: expected,
      });
    }
  });

  describe("the reinstating CAS (real transitionAndEmit + transitionToActiveTx)", () => {
    const reinstate = (id: string) =>
      billing.transitionAndEmit(
        id,
        { status: { not: "ACTIVE" }, ...paymentReinstatableWhere() },
        "ACTIVE",
        1,
        BILLING_EVENTS.SUBSCRIPTION_RESUMED,
        { source: "stripe", reason: "checkout_completed" },
      );

    it.each([
      ["READ_ONLY(admin_set)", "READ_ONLY", "admin_set"],
      ["READ_ONLY(no reason: a legacy admin write)", "READ_ONLY", null],
      ["SUSPENDED(admin_set)", "SUSPENDED", "admin_set"],
      ["CANCELLED", "CANCELLED", null],
    ])("%s: untouched, no ledger event", async (_n, status, reason) => {
      const id = await tenantIn(status, reason, true);
      expect(await reinstate(id)).toBe(false);
      expect(await row(id)).toMatchObject({ status, readOnlyReason: reason });
      expect(await prisma.billingEvent.count({ where: { tenantId: id } })).toBe(0);
    });

    it.each([
      ["TRIAL", "TRIAL", null],
      ["READ_ONLY(trial_expired)", "READ_ONLY", "trial_expired"],
      ["READ_ONLY(payment_overdue)", "READ_ONLY", "payment_overdue"],
      ["SUSPENDED by billing (no reason)", "SUSPENDED", null],
    ])("control: %s lifts exactly once, and the reason is cleared", async (_n, status, reason) => {
      const id = await tenantIn(status, reason, true);
      expect(await reinstate(id)).toBe(true);
      expect(await reinstate(id)).toBe(false); // a second delivery finds it ACTIVE
      expect(await row(id)).toMatchObject({ status: "ACTIVE", readOnlyReason: null });
    });
  });

  describe("subscribe() (real SubscriptionMutationService)", () => {
    it.each([
      ["READ_ONLY(admin_set)", "READ_ONLY", "admin_set"],
      ["SUSPENDED(admin_set)", "SUSPENDED", "admin_set"],
      ["CANCELLED", "CANCELLED", null],
    ])(
      "%s: 409 TENANT_ADMIN_LOCKED, the tenant and its ledger are untouched",
      async (_n, status, reason) => {
        const id = await tenantIn(status, reason, true);
        const err: any = await mutations
          .subscribe(id, { planKey: "STARTER", cycle: "MONTHLY" as any })
          .catch((e) => e);
        expect(err.getStatus?.()).toBe(409);
        expect(err.getResponse?.()).toMatchObject({ code: API_ERROR_CODES.TENANT_ADMIN_LOCKED });
        expect(await row(id)).toMatchObject({ status, readOnlyReason: reason });
        expect(await prisma.billingEvent.count({ where: { tenantId: id } })).toBe(0);
      },
    );

    it("control: a lapsed trial (READ_ONLY trial_expired) still subscribes and becomes ACTIVE", async () => {
      const id = await tenantIn("READ_ONLY", "trial_expired", true);
      await mutations.subscribe(id, { planKey: "STARTER", cycle: "MONTHLY" as any });
      expect(await row(id)).toMatchObject({ status: "ACTIVE", readOnlyReason: null });
    });
  });
});
