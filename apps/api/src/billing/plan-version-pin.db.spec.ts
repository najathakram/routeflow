/**
 * SA-815 / SA-815a (G1c-1) - a tenant pinned to an OLDER catalog version is judged by ITS version, not the published
 * one, on every plan-move inclusion writer; and every plan move leaves BOTH pins equal. Real Postgres.
 *
 * Fixture: the published catalog (v_new) includes NO add-on anywhere; the tenant's pinned version (v_old, a real
 * SUPERSEDED PlanVersion row) includes FORECASTING and REGULATED_ITEMS at SCALE. Each tenant sits on SCALE with that
 * add-on at $0 (included under v_old) and moves DOWN to GROWTH, so v_old's verdict ("leaving inclusion") is the only
 * thing that prices the row.
 *
 * Red on the pre-change code: the plan LEFT was judged on the published catalog, so the row was never "leaving
 * inclusion" and the tenant kept a priced-plan add-on for free; and the plan moves wrote only one of the two pins.
 * Throwaway `qa-*` tenants (assertTestTenant).
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

const SPEC = "plan-version-pin.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb(
  "SA-815a: a pinned tenant is judged by its own catalog version; every plan move sets both pins (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let admin: PlatformAdminService;
    let events: BillingEventService;
    let catalogService: any;
    let newVersionId: string;
    let oldVersionId: string;
    let createdNewId: string | undefined;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;
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
        newVersionId = published.id;
      } else {
        const created = await prisma.planVersion.create({
          data: {
            version:
              ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ??
                0) + 1,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: `qa fixture - ${SPEC}`,
          },
        });
        createdNewId = newVersionId = created.id;
      }
      // the grandfathered version the tenants are pinned to (a real row: the pin columns are foreign keys)
      const old = await prisma.planVersion.create({
        data: {
          version:
            ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) +
            1,
          status: "SUPERSEDED",
          notes: `qa fixture (pinned) - ${SPEC}`,
        },
      });
      oldVersionId = old.id;

      const definitions = [
        {
          planKey: "GROWTH",
          name: "Growth",
          monthlyPrice: 249,
          annualPrice: null,
          isCustom: false,
        },
        { planKey: "SCALE", name: "Scale", monthlyPrice: 499, annualPrice: null, isCustom: false },
      ];
      const sku = (code: string, name: string, includedAtPlan?: string) => ({
        sku: code,
        name,
        monthlyPrice: 25,
        ...(includedAtPlan ? { includedAtPlan } : {}),
      });
      const catalogNew = {
        id: newVersionId,
        status: "PUBLISHED",
        definitions,
        addonSkus: [sku("FORECASTING", "Forecasting"), sku("REGULATED_ITEMS", "Regulated items")],
      };
      const catalogOld = {
        id: oldVersionId,
        status: "SUPERSEDED",
        definitions,
        addonSkus: [
          sku("FORECASTING", "Forecasting", "SCALE"),
          sku("REGULATED_ITEMS", "Regulated items", "SCALE"),
        ],
      };
      catalogService = {
        getPublishedCatalog: () => Promise.resolve(catalogNew),
        getPublishedVersion: () => Promise.resolve(catalogNew),
        getVersionForTenant: (id: string | null) =>
          Promise.resolve(id === oldVersionId ? catalogOld : catalogNew),
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
      if (oldVersionId) await prisma.planVersion.delete({ where: { id: oldVersionId } });
      if (createdNewId) await prisma.planVersion.delete({ where: { id: createdNewId } });
      await prisma?.$disconnect();
      await pool?.end();
    });

    beforeEach(() => {
      stripeCalls.length = 0;
    });

    /** A PRODUCTION tenant on SCALE, BOTH pins on the OLD version, holding one included add-on row. */
    async function pinnedTenant(
      label: string,
      o: {
        status: TenantStatus;
        planKey: "GROWTH" | "SCALE";
        sku: "FORECASTING" | "REGULATED_ITEMS";
        row: { priceSnapshot: number; stripeItemId?: string | null };
        manual?: boolean;
        stripeCustomerId?: string;
        pins?: { tenant: string | null; sub: string | null };
      },
    ): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(`qa-sa815a-${run}-${seq}-${label}`, SPEC);
      const pins = o.pins ?? { tenant: oldVersionId, sub: oldVersionId };
      const tenant = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: o.status,
          planVersionId: pins.tenant,
        },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planKey: o.planKey,
          planVersionId: pins.sub,
          basePriceSnapshot: o.planKey === "SCALE" ? 499 : 249,
          discount: 0,
          cycle: "MONTHLY",
          periodStart: new Date(Date.now() - 15 * DAY),
          periodEnd: new Date(Date.now() + 15 * DAY),
          externalPayment: o.manual ?? true,
          stripeCustomerId: o.stripeCustomerId ?? null,
        },
      });
      await prisma.tenantAddon.create({
        data: {
          tenantId: tenant.id,
          addonKey: o.sku,
          sku: o.sku,
          quantity: 1,
          active: true,
          priceSnapshot: o.row.priceSnapshot,
          stripeItemId: o.row.stripeItemId ?? null,
        },
      });
      return tenant.id;
    }

    const row = (tenantId: string, sku: string) =>
      prisma.tenantAddon.findFirstOrThrow({ where: { tenantId, sku } });
    const pinsOf = async (tenantId: string) => ({
      tenant: (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).planVersionId,
      sub: (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } }))
        .planVersionId,
    });
    const notices = (tenantId: string, action: string) =>
      prisma.auditLog.findMany({ where: { tenantId, action } });

    it("S4 manual activation SCALE -> GROWTH: the PINNED version says the old plan included the add-on, so it is priced; both pins land on the published version", async () => {
      const t = await pinnedTenant("s4", {
        status: TenantStatus.ACTIVE,
        planKey: "SCALE",
        sku: "FORECASTING",
        row: { priceSnapshot: 0 },
      });

      await admin.activateManualSubscription(
        t,
        { plan: "GROWTH", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
        null,
      );

      // Pre-change: priceSnapshot stayed 0 (the published catalog never included it at SCALE).
      expect(Number((await row(t, "FORECASTING")).priceSnapshot)).toBe(25);
      expect(await notices(t, AdminAuditAction.ADDON_MANUAL_INVOICE_DUE)).toHaveLength(1);
      // Pre-change: the tenant pin stayed on the old version (only the subscription's moved).
      expect(await pinsOf(t)).toEqual({ tenant: newVersionId, sub: newVersionId });
      expect(stripeCalls).toEqual([]);
    }, 90_000);

    it("admin updatePlan SCALE -> GROWTH (instant path, READ_ONLY manual tenant): the PINNED version prices the add-on the old plan included; both pins land on the published version", async () => {
      const t = await pinnedTenant("upd", {
        status: TenantStatus.READ_ONLY,
        planKey: "SCALE",
        sku: "REGULATED_ITEMS",
        row: { priceSnapshot: 0 },
      });

      await admin.updatePlan(t, { plan: "GROWTH" } as any, null);

      // Pre-change: priceSnapshot stayed 0.
      expect(Number((await row(t, "REGULATED_ITEMS")).priceSnapshot)).toBe(25);
      expect(await notices(t, AdminAuditAction.ADDON_MANUAL_INVOICE_DUE)).toHaveLength(1);
      expect(await pinsOf(t)).toEqual({ tenant: newVersionId, sub: newVersionId });
      expect(stripeCalls).toEqual([]);
    }, 90_000);

    it("subscribe GROWTH from a lapsed SCALE tenant (manual): the plan LEFT is judged by the pinned version, so the admin-only add-on is priced; both pins land on the published version", async () => {
      const t = await pinnedTenant("sub", {
        status: TenantStatus.READ_ONLY,
        planKey: "SCALE",
        sku: "REGULATED_ITEMS",
        row: { priceSnapshot: 0 },
      });
      const { mutations } = buildCheckoutHarness({
        prisma,
        catalog: catalogService,
        stripe,
        events,
      });

      await mutations.subscribe(t, { planKey: "GROWTH", cycle: "MONTHLY" } as any, undefined);

      // Pre-change: priceSnapshot stayed 0.
      expect(Number((await row(t, "REGULATED_ITEMS")).priceSnapshot)).toBe(25);
      expect(await pinsOf(t)).toEqual({ tenant: newVersionId, sub: newVersionId });
    }, 90_000);

    it("a SUBSCRIPTION pin wins over a missing TENANT pin: a manual activation from {tenant: null, sub: old} still judges the plan left by the old version", async () => {
      const t = await pinnedTenant("mirror", {
        status: TenantStatus.ACTIVE,
        planKey: "SCALE",
        sku: "FORECASTING",
        row: { priceSnapshot: 0 },
        pins: { tenant: null, sub: oldVersionId },
      });

      await admin.activateManualSubscription(
        t,
        { plan: "GROWTH", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
        null,
      );

      expect(Number((await row(t, "FORECASTING")).priceSnapshot)).toBe(25);
      expect(await pinsOf(t)).toEqual({ tenant: newVersionId, sub: newVersionId });
    }, 90_000);

    it("C3 checkout GROWTH -> SCALE: the PINNED version includes the add-on at SCALE, so it stops billing in the activation transaction (the published catalog would have billed it)", async () => {
      const t = await pinnedTenant("c3", {
        status: TenantStatus.ACTIVE,
        planKey: "GROWTH",
        sku: "FORECASTING",
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

      const r = await row(t, "FORECASTING");
      // Pre-change: the row kept price 25 (and was billed again on the new subscription).
      expect([r.active, Number(r.priceSnapshot), r.stripeItemId]).toEqual([true, 0, null]);
      expect(
        (
          await prisma.billingEvent.findMany({
            where: { tenantId: t, type: BILLING_EVENTS.ADDON_DISABLED },
          })
        ).map((e) => Number(e.amountDelta ?? 0)),
      ).toEqual([-25]);
      expect(created).not.toHaveBeenCalled();
    }, 90_000);
  },
);
