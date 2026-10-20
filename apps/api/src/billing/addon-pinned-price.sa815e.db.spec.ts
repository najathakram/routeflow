/**
 * SA-815e - ONE price rule for an add-on, on real Postgres: a tenant pinned to a SUPERSEDED plan version is written,
 * quoted and billed at THAT version's SKU price, never the published one.
 *
 * Fixture: the published catalog prices CUSTOMER_PACK_100, REGULATED_ITEMS and MSRP at $20; the tenant's pinned
 * (SUPERSEDED, a real PlanVersion row with real AddonSku rows) version prices all three at $12. The tenant is a
 * Stripe-billed PRODUCTION tenant on GROWTH holding a live subscription.
 *
 *   1. a SELF-SERVE enable (CUSTOMER_PACK_100)       writes a $12 row (the Stripe item is created at 1200 cents);
 *   2. an admin UN-COMP (REGULATED_ITEMS)            writes a $12 row;
 *   3. an admin ENABLE at the catalog (MSRP)         writes a $12 row;
 *   4. the add-on PREVIEW (prorationPreview)         quotes $12;
 *   5. the checkout LINE of the self-serve row       is 1200 cents;
 *   6. a paid CHECKOUT on a new subscription         bills all three at $12 (three new items at 1200 cents) with no
 *                                                    ADDON_PRICED_NOT_BILLED notice: the admin rows are judged
 *                                                    and billed on the SAME pinned version, never as a mismatch.
 *
 * Red on the previous code: each of 1-5 wrote or quoted $20 and the checkout skipped the two admin rows as a price
 * mismatch against the pinned $12. Throwaway `qa-*` tenants (assertTestTenant).
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
import { AddonService } from "./addon.service";
import { BillingEventService } from "./billing-event.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { buildCheckoutHarness } from "../testing/checkout-completed-harness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "addon-pinned-price.sa815e.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;
const PINNED = 12;
const PUBLISHED = 20;
const SKUS = ["CUSTOMER_PACK_100", "REGULATED_ITEMS", "MSRP"] as const;

describeDb("SA-815e: an add-on is priced at the tenant's PINNED version (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let catalog: PlanCatalogService;
  let events: BillingEventService;
  let createdVersionId: string | undefined;
  let oldVersionId: string;
  let tenantId: string;
  let mutations: SubscriptionMutationService;
  let addons: AddonService;
  const run = randomUUID().slice(0, 8);
  const noop: any = { invalidate: jest.fn() };
  const planTransition: any = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  };

  /** A Stripe stub that keeps the subscription's items, so adopt/create see what an earlier call made. */
  function stripeStub(subId: string, customer: string) {
    const items: any[] = [];
    let n = 0;
    const client = {
      products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
      subscriptionItems: {
        list: jest.fn(async () => ({ data: items.map((i) => ({ ...i })) })),
        create: jest.fn(async (args: any) => {
          const item = {
            id: `si_${run}_${subId}_${++n}`,
            quantity: args.quantity ?? 1,
            metadata: args.metadata ?? {},
            price: { unit_amount: args.price_data?.unit_amount ?? null },
          };
          items.push(item);
          return item;
        }),
        update: jest.fn(),
        del: jest.fn(async (id: string) => {
          const at = items.findIndex((i) => i.id === id);
          if (at >= 0) items.splice(at, 1);
          return { id };
        }),
      },
      invoiceItems: { list: jest.fn().mockResolvedValue({ data: [] }) },
    };
    return {
      items,
      stripe: {
        isConfigured: true,
        client,
        getSubscription: jest.fn(async () => ({
          id: subId,
          status: "active",
          customer,
          metadata: {},
          items: {
            data: [
              {
                id: `si_base_${subId}`,
                quantity: 1,
                current_period_start: Math.floor((Date.now() - DAY) / 1000),
                current_period_end: Math.floor((Date.now() + 29 * DAY) / 1000),
                price: { unit_amount: 24900, product: { name: "Growth" } },
              },
              ...items.map((i) => ({ ...i })),
            ],
          },
        })),
        retrieveSubscriptionWithDiscounts: jest
          .fn()
          .mockResolvedValue({ id: subId, discounts: [] }),
        previewNextInvoice: jest.fn().mockResolvedValue(null),
      } as any,
    };
  }
  const writerStripe = stripeStub("sub_old", "cus_pinned");

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
          { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
        ],
        addons: [
          {
            sku: "CUSTOMER_PACK_100",
            name: "Customer pack",
            monthlyPrice: PUBLISHED,
            stackable: true,
          },
          { sku: "REGULATED_ITEMS", name: "Regulated items", monthlyPrice: PUBLISHED },
          { sku: "MSRP", name: "MSRP", monthlyPrice: PUBLISHED },
        ],
      },
      SPEC,
    );
    catalog = new PlanCatalogService(prisma as any);
    const published = await catalog.getPublishedCatalog();
    for (const sku of SKUS) {
      const def = published.addonSkus.find((s: any) => s.sku === sku);
      if (!def) throw new Error(`the published catalog has no ${sku}`);
      if (Number(def.monthlyPrice) === PINNED) {
        throw new Error(
          `${sku} is already $${PINNED} in the published catalog: the spec cannot tell the versions apart`,
        );
      }
    }
    // the grandfathered version the tenant is pinned to: a real SUPERSEDED row with its own add-on prices
    const maxVersion = (await prisma.planVersion.aggregate({ _max: { version: true } }))._max
      .version;
    const old = await prisma.planVersion.create({
      data: {
        version: (maxVersion ?? 0) + 1,
        status: "SUPERSEDED",
        notes: `qa fixture (pinned) - ${SPEC}`,
        definitions: {
          create: [
            {
              planKey: "GROWTH",
              name: "Growth",
              monthlyPrice: 249,
              isCustom: false,
              featureFlags: [],
            },
            {
              planKey: "SCALE",
              name: "Scale",
              monthlyPrice: 499,
              isCustom: false,
              featureFlags: [],
            },
          ],
        },
        addonSkus: {
          create: SKUS.map((sku) => ({
            sku,
            name: sku,
            monthlyPrice: PINNED,
            grantsFlags: [],
            ...(sku === "CUSTOMER_PACK_100" ? { stackable: true } : {}),
          })),
        },
      } as any,
    });
    oldVersionId = old.id;

    events = new BillingEventService(prisma as any);
    mutations = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
      noop,
      events,
      noop,
      writerStripe.stripe,
      { notifyUpgradeConfirmed: jest.fn() } as any,
      planTransition,
    );
    addons = new AddonService(
      prisma as any,
      writerStripe.stripe,
      noop, // entitlements (cache invalidate only)
      catalog,
      noop, // featureResolver (cache invalidate only)
      { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any, // authority
      events,
      {
        get: jest.fn().mockResolvedValue(null),
        getMany: jest.fn().mockResolvedValue(new Map()),
      } as any,
    );

    const slug = assertTestTenant(`qa-sa815e-${run}`, SPEC);
    const tenant = await prisma.tenant.create({
      data: {
        slug,
        name: slug,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
        planVersionId: oldVersionId,
      },
    });
    tenantId = tenant.id;
    await prisma.tenantSubscription.create({
      data: {
        tenantId,
        planKey: "GROWTH",
        planVersionId: oldVersionId,
        basePriceSnapshot: 249,
        discount: 0,
        cycle: "MONTHLY",
        periodStart: new Date(Date.now() - 15 * DAY),
        periodEnd: new Date(Date.now() + 15 * DAY),
        externalPayment: false,
        stripeSubId: "sub_old",
        stripeCustomerId: "cus_pinned",
      } as any,
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.billingEvent.deleteMany({ where: { tenantId } });
      await prisma.billingNotificationLog.deleteMany({ where: { tenantId } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    if (oldVersionId) {
      await prisma.addonSku.deleteMany({ where: { planVersionId: oldVersionId } });
      await prisma.planDefinition.deleteMany({ where: { planVersionId: oldVersionId } });
      await prisma.planVersion.delete({ where: { id: oldVersionId } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  const rowOf = (sku: string) => prisma.tenantAddon.findFirstOrThrow({ where: { tenantId, sku } });

  it("1-3: a self-serve enable, an admin un-comp and an admin enable at the catalog each write a $12 row", async () => {
    // (1) self-serve
    await mutations.enableAddon(tenantId, "CUSTOMER_PACK_100", 1, "admin-1");
    // (2) un-comp: a comp row exists first (a platform grant), then the admin bills it
    await prisma.tenantAddon.create({
      data: {
        tenantId,
        addonKey: "REGULATED_ITEMS",
        sku: "REGULATED_ITEMS",
        quantity: 1,
        active: true,
        isComp: true,
        priceSnapshot: 0,
      } as any,
    });
    await addons.uncompAddon(tenantId, "REGULATED_ITEMS", "price_reg", "admin-1");
    // (3) admin enable at the catalog (a Stripe price id means: bill it, at the catalog price)
    await addons.enableAddon(tenantId, "MSRP", "price_msrp", true);

    for (const sku of SKUS) {
      const r = await rowOf(sku);
      expect([sku, r.active, r.isComp, Number(r.priceSnapshot)]).toEqual([
        sku,
        true,
        false,
        PINNED,
      ]);
      expect(r.stripeItemId).toBeTruthy();
    }
    // the self-serve Stripe item was created at the pinned price, not the published one
    const pack = writerStripe.stripe.client.subscriptionItems.create.mock.calls.find(
      (c: any[]) => c[0].metadata?.sku === "CUSTOMER_PACK_100",
    );
    expect(pack![0].price_data.unit_amount).toBe(PINNED * 100);
  }, 90_000);

  it("4: the add-on preview quotes the pinned $12", async () => {
    const preview = await new ProrationService(prisma as any, catalog).prorationPreview(
      tenantId,
      "CUSTOMER_PACK_100",
    );
    expect(preview.monthly).toBe(PINNED);
  });

  it("5-6: the checkout line is 1200 cents and a paid checkout on a NEW subscription bills all three rows at $12 with no mismatch notice", async () => {
    // the old subscription is gone (a checkout only ever runs for a tenant with no live one): its items are dead
    await prisma.tenantSubscription.update({ where: { tenantId }, data: { stripeSubId: null } });
    const fresh = stripeStub("sub_new", "cus_pinned");
    const harness = buildCheckoutHarness({
      prisma,
      catalog,
      stripe: fresh.stripe,
      events,
      monthly: 249,
    });

    const { lineItems } = await harness.mutations.checkoutAddonLines(tenantId, "month");
    expect(lineItems.map((l: any) => l.price_data.unit_amount)).toEqual([PINNED * 100]);

    await harness.complete({
      id: `cs_${run}`,
      customer: "cus_pinned",
      subscription: "sub_new",
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000),
      metadata: { tenantId, planKey: "GROWTH" },
    });

    // all three were billed on the new subscription, each through one item at 1200 cents
    const created = fresh.stripe.client.subscriptionItems.create.mock.calls.map((c: any[]) => [
      c[0].metadata.sku,
      c[0].price_data.unit_amount,
    ]);
    expect(created.sort()).toEqual(SKUS.map((s) => [s, PINNED * 100]).sort());
    for (const sku of SKUS) {
      const r = await rowOf(sku);
      expect([sku, Number(r.priceSnapshot)]).toEqual([sku, PINNED]);
      expect(r.stripeItemId).toMatch(new RegExp(`^si_${run}_sub_new_`));
    }
    const notices = await prisma.auditLog.findMany({
      where: { tenantId, action: AdminAuditAction.ADDON_PRICED_NOT_BILLED },
    });
    expect(notices).toEqual([]);
  }, 90_000);
});
