/**
 * G1a on REAL Postgres, REAL advisory locks (no db-locks mock): the plan-change add-on bill
 * (`billAddonsLeavingInclusion` -> `billUnbilledRow` -> create the `{tenantId, sku}` item, then claim it onto the row)
 * runs under the same `addon:<tenant>:<sku>` lock as enable / disable / checkout adoption. Without it, a stranded-item
 * sweep (which runs under that lock) could list the freshly created, not-yet-claimed item as "held by no row" and
 * delete it, and the claim would then point the row at a deleted item (silent under-billing).
 *
 * LOCK ORDER (pinned in db-locks.ts): `tenant-price` before `addon:<tenant>:<sku>`, never the reverse. The scheduled
 * downgrade sweep holds the tenant-price lock while it bills the leaving add-ons after commit, so the bill below is
 * run INSIDE `underTenantPriceLock`, exactly like the cron, while an admin enable of the same SKU runs outside it.
 *
 * Only Stripe (a stateful in-memory fake with a gate on `create`) and cache invalidators are stubbed. Tenants are
 * throwaway `qa-*` slugs.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { BillingEventService } from "./billing-event.service";
import { underTenantPriceLock } from "./price-lock";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "addon-plan-change-lock.db.spec.ts";
const SKU = "FORECASTING";
const SKUS = [{ sku: SKU, name: "Forecasting", monthlyPrice: 25, includedAtPlan: "SCALE" }];

describeDb("G1a: the plan-change add-on bill holds the add-on lock (real Postgres)", () => {
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
        plans: [
          { planKey: "STARTER", name: "Starter", monthlyPrice: 99 },
          { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
        ],
        addons: [{ sku: SKU, name: "Forecasting", monthlyPrice: 25, stackable: true }],
      },
      SPEC,
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

  /** A Stripe tenant on STARTER holding an ACTIVE $0 quantity-1 FORECASTING row with no item (the leaving case). */
  async function rig() {
    seq += 1;
    const slug = assertTestTenant(`qa-g1a-${run}-${seq}`, SPEC);
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(tenant.id);
    const subId = `sub_qa_${run}_${seq}`;
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "STARTER",
        stripeSubId: subId,
        stripeCustomerId: null,
        billingInterval: "month",
        cycle: "MONTHLY",
        discount: 0,
      } as any,
    });
    await prisma.tenantAddon.create({
      data: {
        tenantId: tenant.id,
        addonKey: SKU,
        sku: SKU,
        quantity: 1,
        active: true,
        isComp: false,
        priceSnapshot: 0,
      },
    });
    const items: any[] = [{ id: "si_base", quantity: 1, created: 1, price: { unit_amount: 9900 } }];
    // `create` parks on this gate once it has made the item, so a test can run other work while the plan-change
    // bill is between "item created" and "claimed onto the row".
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const createEntered = new Promise<void>((r) => (entered = r));
    let n = 0;
    const stripe: any = {
      isConfigured: true,
      client: {
        products: { create: jest.fn(async () => ({ id: "prod_qa" })) },
        invoiceItems: { list: jest.fn(async () => ({ data: [] })) },
        subscriptionItems: {
          list: jest.fn(async () => ({ data: items.map((i) => ({ ...i })) })),
          create: jest.fn(async (args: any) => {
            // already older than the sweep's age floor: only the LOCK can protect it in the overlap test
            const item = {
              id: `si_new_${run}_${++n}`,
              quantity: args.quantity,
              created: Math.floor(Date.now() / 1000) - 3600,
              metadata: args.metadata,
              price: { unit_amount: args.price_data.unit_amount },
            };
            items.push(item);
            entered();
            await gate;
            return item;
          }),
          update: jest.fn(async (id: string, p: any) => {
            const hit = items.find((i) => i.id === id);
            if (hit) hit.quantity = p.quantity;
            return { id };
          }),
          del: jest.fn(async (id: string) => {
            const at = items.findIndex((i) => i.id === id);
            if (at >= 0) items.splice(at, 1);
            return { id };
          }),
        },
      },
    };
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
    const row = () => prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: tenant.id } });
    // The scheduled-downgrade cron bills the leaving add-ons AFTER commit while it holds the tenant-price lock.
    const billLikeTheCron = async () => {
      const { id } = await row();
      return underTenantPriceLock(tenant.id, () =>
        mutations.billAddonsLeavingInclusion(
          tenant.id,
          [{ id, code: SKU, quantity: 1 }],
          SKUS as any,
          "plan_change",
          { prorationBehavior: "always_invoice" } as any,
        ),
      );
    };
    return {
      tenantId: tenant.id,
      subId,
      mutations,
      stripe,
      items,
      row,
      release,
      createEntered,
      billLikeTheCron,
    };
  }

  const settleWithin = async <T>(p: Promise<T>, ms: number): Promise<"timeout" | T> =>
    Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

  it("a stranded-item sweep that overlaps the plan-change create WAITS for the claim and then spares the item", async () => {
    const r = await rig();
    const row0 = await r.row();
    // the bill is addressed by row id: the row the cron read
    const bill = r.mutations.billAddonsLeavingInclusion(
      r.tenantId,
      [{ id: row0.id, code: SKU, quantity: 1 }],
      SKUS as any,
      "plan_change",
      { prorationBehavior: "always_invoice" } as any,
    );
    await r.createEntered; // the item exists in Stripe, the row does not hold it yet
    const listsBefore = r.stripe.client.subscriptionItems.list.mock.calls.length;

    const sweep = (r.mutations as any).sweepStrandedUnderLock(r.tenantId, SKU, r.subId);
    await new Promise((res) => setTimeout(res, 400));
    // with the lock the sweep has not even listed yet
    expect(r.stripe.client.subscriptionItems.list.mock.calls.length).toBe(listsBefore);

    r.release();
    await bill;
    await sweep;

    expect(r.stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    const after = await r.row();
    expect(after.stripeItemId).toMatch(/^si_new_/);
    expect(r.items.map((i) => i.id)).toContain(after.stripeItemId);
  }, 60_000);

  it("a scheduled downgrade's after-commit bill (under the tenant-price lock) and an admin enable of the same SKU: no deadlock, exactly ONE Stripe item", async () => {
    const r = await rig();
    r.release(); // no gate in this case
    const outcomes = await settleWithin(
      Promise.allSettled([
        r.billLikeTheCron(),
        r.mutations.enableAddon(r.tenantId, SKU, 2, undefined, undefined),
      ]),
      30_000,
    );

    expect(outcomes).not.toBe("timeout"); // a deadlock would hang both until the lock waits expire
    const created = r.stripe.client.subscriptionItems.create.mock.calls.length;
    expect(created).toBe(1);
    const addonItems = r.items.filter((i) => i.id !== "si_base");
    expect(addonItems).toHaveLength(1);
    const after = await r.row();
    expect(after.stripeItemId).toBe(addonItems[0].id);
  }, 60_000);
});
