/**
 * SA-815 B3 / SA-786 S4 + SA-787 C3 - the two inclusion writers an admin reaches on a live tenant, real Postgres.
 *
 *  - S4  `PlatformAdminService.activateManualSubscription` on an already-paying manual tenant that CHANGES plan:
 *        UP   -> an add-on the new plan includes stays ACTIVE at $0, its item pointer clears, no Stripe call;
 *        DOWN -> an add-on the old plan included is priced at the catalog price and the platform is told to invoice it.
 *  - C3  a PAID card checkout that moves the plan (`onCheckoutCompleted`): the add-on the new plan includes stays
 *        ACTIVE at $0 inside the activation transaction, and the adoption step creates no item for it.
 *
 * Red on master: neither writer touched add-on rows on a plan move, so the included row kept its price (and, at the
 * checkout, was left carrying a dead subscription's item pointer) and the leaving row stayed at $0 forever.
 * Throwaway `qa-*` tenants (assertTestTenant); a stand-in plan graph that borrows a real PlanVersion id for the FKs.
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
import { ProrationService } from "./proration.service";
import { MrrService } from "./mrr.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { buildCheckoutHarness } from "../testing/checkout-completed-harness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "admin-inclusion-writers.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb(
  "SA-815 B3: the admin-path inclusion writers (S4 manual activation, C3 checkout) (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let admin: PlatformAdminService;
    let events: BillingEventService;
    let catalogService: any;
    let versionId: string;
    let createdVersionId: string | undefined;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;
    // Any Stripe call is a failure: these paths must push nothing (manual pay / no live subscription).
    const stripeCalls: string[] = [];
    const stripe: any = {
      isConfigured: true,
      client: new Proxy(
        {},
        {
          get: (_t, prop) => {
            stripeCalls.push(`client.${String(prop)}`);
            throw new Error(`Stripe client.${String(prop)} must not be called`);
          },
        },
      ),
      getSubscription: jest.fn(async () => {
        throw new Error("Stripe getSubscription must not be called");
      }),
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
      const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
      if (published) {
        versionId = published.id;
      } else {
        const version =
          ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
        const created = await prisma.planVersion.create({
          data: {
            version,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: `qa fixture - ${SPEC}`,
          },
        });
        createdVersionId = versionId = created.id;
      }
      // FORECASTING is bundled at SCALE and above.
      const catalog = {
        id: versionId,
        definitions: [
          {
            planKey: "GROWTH",
            name: "Growth",
            monthlyPrice: 249,
            annualPrice: null,
            isCustom: false,
          },
          {
            planKey: "SCALE",
            name: "Scale",
            monthlyPrice: 499,
            annualPrice: null,
            isCustom: false,
          },
        ],
        addonSkus: [
          { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25, includedAtPlan: "SCALE" },
        ],
      };
      catalogService = {
        getPublishedCatalog: () => Promise.resolve(catalog),
        getPublishedVersion: () => Promise.resolve(catalog),
        getVersionForTenant: () => Promise.resolve(catalog),
      };
      events = new BillingEventService(prisma as any);
      const noop: any = { invalidate: jest.fn() };
      const planTransition: any = {
        isEnabled: () => Promise.resolve(false),
        prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
        onPlanChange: () => Promise.resolve({ action: "none" }),
        transactionOptions: () => undefined,
        invalidateCaches: () => undefined,
      };
      admin = new PlatformAdminService(
        prisma as any,
        noop, // jwtService
        noop, // config
        noop, // emailService
        noop, // billingService
        noop, // pricing
        catalogService,
        new ProrationService(prisma as any, catalogService),
        noop, // entitlementsService
        events,
        noop, // meterService
        noop, // tenantStatusGuard
        { log: jest.fn().mockResolvedValue(undefined) } as any, // auditService
        new MrrService(prisma as any),
        noop, // tenantMirror
        noop, // featureOverrides
        planTransition,
        stripe,
      );
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
      if (createdVersionId) await prisma.planVersion.delete({ where: { id: createdVersionId } });
      await prisma?.$disconnect();
      await pool?.end();
    });

    beforeEach(() => {
      stripeCalls.length = 0;
    });

    /** An ACTIVE, paying PRODUCTION tenant on `planKey` holding one FORECASTING row. */
    async function tenantWithForecasting(
      label: string,
      o: {
        planKey: "GROWTH" | "SCALE";
        base: number;
        manual: boolean;
        row: { priceSnapshot: number; stripeItemId?: string | null };
        stripeCustomerId?: string;
      },
    ): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(`qa-sa815-b3-${run}-${seq}-${label}`, SPEC);
      const tenant = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: TenantStatus.ACTIVE,
          planVersionId: versionId,
        },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planKey: o.planKey,
          planVersionId: versionId,
          basePriceSnapshot: o.base,
          discount: 0,
          cycle: "MONTHLY",
          periodStart: new Date(Date.now() - 15 * DAY),
          periodEnd: new Date(Date.now() + 15 * DAY),
          externalPayment: o.manual,
          stripeCustomerId: o.stripeCustomerId ?? null,
        },
      });
      await prisma.tenantAddon.create({
        data: {
          tenantId: tenant.id,
          addonKey: "FORECASTING",
          sku: "FORECASTING",
          quantity: 1,
          active: true,
          priceSnapshot: o.row.priceSnapshot,
          stripeItemId: o.row.stripeItemId ?? null,
        },
      });
      return tenant.id;
    }

    const row = (tenantId: string) =>
      prisma.tenantAddon.findFirstOrThrow({ where: { tenantId, sku: "FORECASTING" } });
    const delta = async (tenantId: string, type: string) =>
      (await prisma.billingEvent.findMany({ where: { tenantId, type } })).map((e) =>
        Number(e.amountDelta ?? 0),
      );
    const notices = (tenantId: string, action: string) =>
      prisma.auditLog.findMany({ where: { tenantId, action } });

    it("S4 UP: a manual activation GROWTH -> SCALE keeps the included add-on ON at $0, clears its pointer, books -price once, pushes nothing", async () => {
      const t = await tenantWithForecasting("s4-up", {
        planKey: "GROWTH",
        base: 249,
        manual: true,
        row: { priceSnapshot: 25 },
      });

      await admin.activateManualSubscription(
        t,
        { plan: "SCALE", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
        null,
      );

      const r = await row(t);
      // Master: priceSnapshot stayed 25 (the activation never looked at the add-on rows).
      expect([r.active, Number(r.priceSnapshot), r.stripeItemId]).toEqual([true, 0, null]);
      expect(await delta(t, BILLING_EVENTS.ADDON_DISABLED)).toEqual([-25]);
      expect(await delta(t, BILLING_EVENTS.PLAN_CHANGED)).toEqual([250]);
      expect(await notices(t, AdminAuditAction.ADDON_MANUAL_INVOICE_STOP)).toHaveLength(1);
      expect(stripeCalls).toEqual([]);
    }, 60_000);

    it("S4 DOWN: a manual activation SCALE -> GROWTH PRICES the add-on the old plan included at the catalog price, books +price once, writes the DUE notice, pushes nothing", async () => {
      const t = await tenantWithForecasting("s4-down", {
        planKey: "SCALE",
        base: 499,
        manual: true,
        row: { priceSnapshot: 0 },
      });

      await admin.activateManualSubscription(
        t,
        { plan: "GROWTH", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
        null,
      );

      const r = await row(t);
      // Master: priceSnapshot stayed 0 - the tenant kept a priced-plan add-on for free forever.
      expect([r.active, Number(r.priceSnapshot), r.stripeItemId]).toEqual([true, 25, null]);
      expect(await delta(t, BILLING_EVENTS.ADDON_ENABLED)).toEqual([25]);
      expect(await delta(t, BILLING_EVENTS.PLAN_CHANGED)).toEqual([-250]);
      const due = await notices(t, AdminAuditAction.ADDON_MANUAL_INVOICE_DUE);
      expect(due).toHaveLength(1);
      expect(due[0].meta).toMatchObject({ sku: "FORECASTING", kind: "add", monthlyPrice: 25 });
      expect(stripeCalls).toEqual([]);
    }, 60_000);

    it("C3: a paid checkout that moves GROWTH -> SCALE stops billing the add-on SCALE includes inside the activation transaction: ON at $0, dead pointer cleared, no item created", async () => {
      const t = await tenantWithForecasting("c3", {
        planKey: "GROWTH",
        base: 249,
        manual: false,
        // a priced row whose item lives on the dead subscription this checkout replaces
        row: { priceSnapshot: 25, stripeItemId: "si_dead_c3" },
        stripeCustomerId: "cus_c3",
      });
      const baseItem = {
        id: "si_base_c3",
        quantity: 1,
        current_period_start: Math.floor((Date.now() - DAY) / 1000),
        current_period_end: Math.floor((Date.now() + 29 * DAY) / 1000),
        price: { unit_amount: 49900, product: { name: "Scale" } },
      };
      const created = jest.fn();
      const checkoutStripe: any = {
        isConfigured: true,
        client: {
          products: { create: created },
          subscriptionItems: {
            create: created,
            // a dead subscription's item is not on the new subscription
            list: jest.fn().mockResolvedValue({ data: [], has_more: false }),
            update: created,
            del: created,
          },
        },
        getSubscription: jest.fn(async () => ({
          id: "sub_c3",
          status: "active",
          customer: "cus_c3",
          metadata: {},
          items: { data: [baseItem] },
        })),
        retrieveSubscriptionWithDiscounts: jest
          .fn()
          .mockResolvedValue({ id: "sub_c3", discounts: [] }),
        previewNextInvoice: jest.fn().mockResolvedValue(null),
      };
      const harness = buildCheckoutHarness({
        prisma,
        catalog: catalogService,
        stripe: checkoutStripe,
        events,
        monthly: 499,
      });

      await harness.complete({
        id: `cs_c3_${run}`,
        customer: "cus_c3",
        subscription: "sub_c3",
        payment_status: "paid",
        created: Math.floor(Date.now() / 1000),
        metadata: { tenantId: t, planKey: "SCALE" },
      });

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
      expect([sub.planKey, sub.stripeSubId]).toEqual(["SCALE", "sub_c3"]);
      const r = await row(t);
      // Master: the row kept price 25 and the dead subscription's item pointer.
      expect([r.active, Number(r.priceSnapshot), r.stripeItemId]).toEqual([true, 0, null]);
      expect(await delta(t, BILLING_EVENTS.ADDON_DISABLED)).toEqual([-25]);
      // nothing was created or touched in Stripe for the included add-on
      expect(created).not.toHaveBeenCalled();

      // a redelivery is a no-op: nothing more booked, the row is still ON at $0
      await harness.complete({
        id: `cs_c3_${run}`,
        customer: "cus_c3",
        subscription: "sub_c3",
        payment_status: "paid",
        created: Math.floor(Date.now() / 1000),
        metadata: { tenantId: t, planKey: "SCALE" },
      });
      expect(await delta(t, BILLING_EVENTS.ADDON_DISABLED)).toEqual([-25]);
      expect(created).not.toHaveBeenCalled();
    }, 60_000);
  },
);
