/**
 * M11 on REAL Postgres: the enable body's `quantity` is the TARGET total, so a stale "Buy more" could cut a
 * pack. `expectedQuantity` is compared with the stored quantity UNDER the real `addon:<tenant>:<sku>`
 * advisory lock (a pinned connection), before any Stripe call. This spec proves what the unit spec's
 * pass-through lock cannot: with two simultaneous buy-mores that both saw the same owned count, the lock
 * serialises them, exactly ONE reaches Stripe and the loser gets the coded 409 from the winner's committed row.
 * Real SubscriptionMutationService, PlanCatalogService, BillingEventService; only Stripe (spied boundary) and
 * cache invalidators are stubbed. Tenants are throwaway `qa-*` slugs.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { BillingEventService } from "./billing-event.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("M11 — expectedQuantity is compared under the add-on lock (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let createdVersionId: string | undefined;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  const stub = () =>
    new Proxy(
      {},
      { get: (_t, k) => (k === "then" ? undefined : jest.fn().mockResolvedValue(undefined)) },
    ) as any;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [{ planKey: "STARTER", name: "Starter", monthlyPrice: 99 }],
        addons: [
          {
            sku: "CUSTOMER_PACK_100",
            name: "Customer pack (+100)",
            monthlyPrice: 50,
            stackable: true,
          },
        ],
      },
      "subscription-mutation.addon-quantity.db.spec.ts",
    );
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** An ACTIVE, Stripe-billed tenant that already owns `owned` Customer packs on item si_qa. */
  async function rig(owned: number) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-m11q-${run}-${seq}`,
      "subscription-mutation.addon-quantity.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(tenant.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "STARTER",
        stripeSubId: `sub_qa_${run}_${seq}`,
        stripeCustomerId: "cus_qa",
        billingInterval: "month",
        discount: 0,
      } as any,
    });
    await prisma.tenantAddon.create({
      data: {
        tenantId: tenant.id,
        addonKey: "CUSTOMER_PACK_100",
        sku: "CUSTOMER_PACK_100",
        quantity: owned,
        active: true,
        isComp: false,
        priceSnapshot: 50,
        stripeItemId: "si_qa",
      },
    });
    const update = jest.fn(async (id: string) => ({ id }));
    const stripe = {
      isConfigured: true,
      client: {
        subscriptionItems: { update, create: jest.fn(), del: jest.fn(), list: jest.fn() },
        invoiceItems: { list: jest.fn(async () => ({ data: [] })) },
      },
    } as any;
    const catalog = new PlanCatalogService(prisma as any);
    const mutations = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
      { invalidate: jest.fn() } as any,
      new BillingEventService(prisma as any),
      stub(),
      stripe,
      stub(),
      {
        isEnabled: () => Promise.resolve(false),
        prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
        onPlanChange: () => Promise.resolve({ action: "none" }),
        transactionOptions: () => undefined,
        invalidateCaches: () => undefined,
      } as any,
    );
    const qty = async () =>
      (await prisma.tenantAddon.findFirst({ where: { tenantId: tenant.id } }))!.quantity;
    const events = () => prisma.billingEvent.count({ where: { tenantId: tenant.id } });
    return { tenantId: tenant.id, mutations, update, qty, events };
  }

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e: any) {
      return { status: e.getStatus?.(), code: e.getResponse?.().code };
    }
    return null;
  };

  it("a stale expectedQuantity is a 409 ADDON_QUANTITY_CHANGED: Stripe is never called, the row and ledger are untouched", async () => {
    const r = await rig(6);
    const out = await codeOf(
      r.mutations.enableAddon(r.tenantId, "CUSTOMER_PACK_100", 3, undefined, 2),
    );
    expect(out).toEqual({ status: 409, code: API_ERROR_CODES.ADDON_QUANTITY_CHANGED });
    expect(r.update).toHaveBeenCalledTimes(0);
    expect(await r.qty()).toBe(6);
    expect(await r.events()).toBe(0);
  });

  it("a matching expectedQuantity raises the pack once: one Stripe update, the row at the new total", async () => {
    const r = await rig(6);
    await r.mutations.enableAddon(r.tenantId, "CUSTOMER_PACK_100", 7, undefined, 6);
    expect(r.update).toHaveBeenCalledTimes(1);
    expect(await r.qty()).toBe(7);
  });

  it("a buy-more never reduces: a target at or below the expected quantity is refused, nothing changes", async () => {
    const r = await rig(6);
    const out = await codeOf(
      r.mutations.enableAddon(r.tenantId, "CUSTOMER_PACK_100", 3, undefined, 6),
    );
    expect(out).toEqual({ status: 409, code: API_ERROR_CODES.ADDON_QUANTITY_NOT_INCREASED });
    expect(r.update).toHaveBeenCalledTimes(0);
    expect(await r.qty()).toBe(6);
  });

  it("two simultaneous buy-mores that saw the same total: the lock lets ONE through, the other is a 409 from the committed row", async () => {
    const r = await rig(6);
    const results = await Promise.all([
      codeOf(r.mutations.enableAddon(r.tenantId, "CUSTOMER_PACK_100", 7, undefined, 6)),
      codeOf(r.mutations.enableAddon(r.tenantId, "CUSTOMER_PACK_100", 7, undefined, 6)),
    ]);
    expect(results.filter((x) => x === null)).toHaveLength(1);
    expect(results.filter((x) => x?.code === API_ERROR_CODES.ADDON_QUANTITY_CHANGED)).toHaveLength(
      1,
    );
    expect(r.update).toHaveBeenCalledTimes(1);
    expect(await r.qty()).toBe(7);
  });
});
