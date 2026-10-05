/**
 * SA-690 option A on REAL Postgres: the checkout-completion adoption of a trial's add-ons.
 *
 * The unit spec (trial-addon-checkout.spec.ts) proves the logic over an in-memory table; this one
 * proves what only a database proves — the compare-and-swap, the tenant row lock, the shared
 * `addon:<tenant>:<sku>` advisory lock and the append-only ledger under TWO simultaneous deliveries
 * of the same completion (a Stripe retry racing the original). Real BillingService,
 * SubscriptionMutationService, BillingEventService, PlanCatalogService; only Stripe (an in-memory
 * subscription whose items are shaped like the pinned 2026-08-26.dahlia objects), cache invalidators
 * and notifications are stubbed. Tenants are throwaway `qa-*` slugs.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingService } from "./billing.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-690 — trial add-ons are adopted at checkout completion (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let catalog: PlanCatalogService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  let createdVersionId: string | undefined;
  /** Catalog monthly prices, read back (a pre-existing published catalog is reused untouched). */
  const price: Record<string, number> = {};

  const stub = () =>
    new Proxy(
      {},
      { get: (_t, k) => (k === "then" ? undefined : jest.fn().mockResolvedValue(undefined)) },
    ) as any;
  const planTransitionStub = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  } as any;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [{ planKey: "STARTER", name: "Starter", monthlyPrice: 99 }],
        addons: [
          { sku: "CUSTOMER_PACK_100", name: "Customer pack (+100)", monthlyPrice: 50 },
          { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19 },
        ],
      },
      "trial-addon-checkout.db.spec.ts",
    );
    catalog = new PlanCatalogService(prisma as any);
    const published = await catalog.getPublishedCatalog();
    for (const sku of ["CUSTOMER_PACK_100", "FORECASTING"]) {
      const def = published.addonSkus.find((s: any) => s.sku === sku);
      if (!def) throw new Error(`the published catalog has no ${sku}`);
      price[sku] = Number(def.monthlyPrice);
    }
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

  /** An item of the in-memory Stripe subscription, as dahlia returns it with the product expanded. */
  const stripeItem = (id: string, o: { sku?: string; cents: number; quantity: number }) => ({
    id,
    object: "subscription_item",
    created: 1791172886,
    current_period_start: 1791172886,
    current_period_end: 1793851286,
    discounts: [],
    metadata: {},
    quantity: o.quantity,
    subscription: "sub_qa",
    price: {
      id: `price_${id}`,
      object: "price",
      currency: "usd",
      metadata: {},
      recurring: { interval: "month", interval_count: 1 },
      type: "recurring",
      unit_amount: o.cents,
      unit_amount_decimal: String(o.cents),
      product: {
        id: `prod_${id}`,
        object: "product",
        name: o.sku ? `RouteFlow add-on — ${o.sku}` : "RouteFlow Starter — monthly",
        metadata: o.sku ? { addonSku: o.sku } : {},
      },
    },
  });

  interface Rig {
    tenantId: string;
    billing: BillingService;
    items: any[];
    stripeClient: any;
    completed: () => Promise<void>;
    ledger: () => Promise<Array<{ type: string; delta: number; sku?: string }>>;
    ledgerSum: () => Promise<number>;
    rows: () => Promise<any[]>;
  }

  async function rig(opts: {
    rows: Array<{ sku: string; quantity: number; active?: boolean }>;
    items: any[];
  }): Promise<Rig> {
    seq += 1;
    const slug = assertTestTenant(`qa-optA-${run}-${seq}`, "trial-addon-checkout.db.spec.ts");
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.TRIAL },
    });
    tenantIds.push(tenant.id);
    await prisma.tenantSubscription.create({
      data: { tenantId: tenant.id, stripeCustomerId: "cus_qa", discount: 0 } as any,
    });
    for (const r of opts.rows) {
      await prisma.tenantAddon.create({
        data: {
          tenantId: tenant.id,
          addonKey: r.sku,
          sku: r.sku,
          quantity: r.quantity,
          active: r.active ?? true,
          priceSnapshot: 0,
        },
      });
    }

    const items = [...opts.items];
    let itemSeq = 0;
    const stripeClient = {
      products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
      subscriptionItems: {
        list: jest.fn(async () => ({ data: items.map((i) => ({ ...i })) })),
        create: jest.fn(async (args: any) => {
          const item = {
            ...stripeItem(`si_new${++itemSeq}`, { cents: 0, quantity: args.quantity }),
            metadata: args.metadata,
          };
          items.push(item);
          return item;
        }),
        update: jest.fn(async (id: string, args: any) => {
          const i = items.find((x) => x.id === id);
          if (i && args?.quantity != null) i.quantity = args.quantity;
          return { id };
        }),
        del: jest.fn(async (id: string) => {
          const i = items.findIndex((x) => x.id === id);
          if (i >= 0) items.splice(i, 1);
          return {};
        }),
      },
      invoiceItems: { list: jest.fn().mockResolvedValue({ data: [] }) },
    };
    const stripe = {
      isConfigured: true,
      client: stripeClient,
      getSubscription: jest.fn(async () => ({
        id: "sub_qa",
        object: "subscription",
        status: "active",
        items: { object: "list", data: items.map((i) => ({ ...i })) },
      })),
    } as any;

    const events = new BillingEventService(prisma as any);
    const mutations = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
      { invalidate: jest.fn() } as any,
      events,
      stub(),
      stripe,
      stub(),
      planTransitionStub,
    );
    const billing = new BillingService(
      prisma as any,
      stripe,
      stub(),
      { invalidate: jest.fn() } as any,
      events,
      { resolveCatalogPricing: jest.fn().mockResolvedValue({ monthly: 99 }) } as any,
      stub(),
      planTransitionStub,
      mutations,
    );

    const session = {
      id: `cs_qa_${run}_${seq}`,
      object: "checkout.session",
      customer: "cus_qa",
      subscription: "sub_qa",
      created: 1791172800,
      metadata: { tenantId: tenant.id, planKey: "STARTER", interval: "month" },
    };
    const completed = () =>
      billing.handleWebhookEvent({
        id: `evt_qa_${run}_${seq}`,
        type: "checkout.session.completed",
        data: { object: session },
      });
    const evs = async () =>
      (
        await prisma.billingEvent.findMany({
          where: { tenantId: tenant.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      ).map((e) => ({
        type: e.type,
        delta: Number(e.amountDelta ?? 0),
        sku: (e.payload as any)?.sku as string | undefined,
      }));
    return {
      tenantId: tenant.id,
      billing,
      items,
      stripeClient,
      completed,
      ledger: evs,
      ledgerSum: async () => (await evs()).reduce((s, e) => s + e.delta, 0),
      rows: () =>
        prisma.tenantAddon.findMany({ where: { tenantId: tenant.id }, orderBy: { sku: "asc" } }),
    };
  }

  const base = () => stripeItem("si_base", { cents: 9900, quantity: 1 });

  it("adopts each checkout item once; the crossing books the base FIRST, then one stored→actual delta per add-on", async () => {
    const r = await rig({
      rows: [
        { sku: "CUSTOMER_PACK_100", quantity: 2 },
        { sku: "FORECASTING", quantity: 1 },
      ],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        stripeItem("si_fc", { sku: "FORECASTING", cents: 1900, quantity: 1 }),
      ],
    });

    await r.completed();

    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId } })).status).toBe(
      TenantStatus.ACTIVE,
    );
    expect(
      (await r.rows()).map((x) => [x.sku, x.stripeItemId, Number(x.priceSnapshot), x.quantity]),
    ).toEqual([
      ["CUSTOMER_PACK_100", "si_pack", 50, 2],
      ["FORECASTING", "si_fc", 19, 1],
    ]);
    expect(await r.ledger()).toEqual([
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99, sku: undefined },
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 19, sku: "FORECASTING" },
    ]);
    // what Stripe bills monthly: 99 + 2×50 + 19
    expect(await r.ledgerSum()).toBe(218);
  });

  it("a SEQUENTIAL redelivery books nothing and touches no Stripe item", async () => {
    const r = await rig({
      rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
      ],
    });
    await r.completed();
    const afterFirst = await r.ledger();

    await r.completed();

    expect(await r.ledger()).toEqual(afterFirst);
    expect(r.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
    expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("TWO SIMULTANEOUS deliveries of the same completion book exactly once (locks + compare-and-swap)", async () => {
    const r = await rig({
      rows: [
        { sku: "CUSTOMER_PACK_100", quantity: 2 },
        { sku: "FORECASTING", quantity: 1 },
      ],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        stripeItem("si_fc", { sku: "FORECASTING", cents: 1900, quantity: 1 }),
      ],
    });

    await Promise.all([r.completed(), r.completed()]);

    const ledger = await r.ledger();
    expect(ledger.filter((e) => e.type === BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toHaveLength(1);
    expect(ledger.filter((e) => e.sku === "CUSTOMER_PACK_100")).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
    ]);
    expect(ledger.filter((e) => e.sku === "FORECASTING")).toHaveLength(1);
    expect(await r.ledgerSum()).toBe(218);
    expect(r.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it("the ROW's quantity wins: row 3 / item 2 raises the item to 3 (+50), row 1 / item 2 cuts it to 1 (-50), row quantity untouched", async () => {
    const raise = await rig({
      rows: [{ sku: "CUSTOMER_PACK_100", quantity: 3 }],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
      ],
    });
    await raise.completed();
    expect(raise.stripeClient.subscriptionItems.update).toHaveBeenCalledWith("si_pack", {
      quantity: 3,
      proration_behavior: "create_prorations",
    });
    expect(raise.items.find((i) => i.id === "si_pack").quantity).toBe(3);
    expect((await raise.rows())[0]).toMatchObject({ stripeItemId: "si_pack", quantity: 3 });
    expect(
      (await raise.ledger()).filter((e) => e.sku === "CUSTOMER_PACK_100").map((e) => e.delta),
    ).toEqual([100, 50]);
    expect(await raise.ledgerSum()).toBe(99 + 150);

    const cut = await rig({
      rows: [{ sku: "CUSTOMER_PACK_100", quantity: 1 }],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
      ],
    });
    await cut.completed();
    expect(cut.stripeClient.subscriptionItems.update).toHaveBeenCalledWith("si_pack", {
      quantity: 1,
      proration_behavior: "create_prorations",
    });
    expect((await cut.rows())[0]).toMatchObject({ stripeItemId: "si_pack", quantity: 1 });
    expect(
      (await cut.ledger()).filter((e) => e.sku === "CUSTOMER_PACK_100").map((e) => e.delta),
    ).toEqual([100, -50]);
    expect(await cut.ledgerSum()).toBe(99 + 50);
  });

  it("(a) a row switched off before completion: its item is deleted with prorations, only the crossing is booked", async () => {
    const r = await rig({
      rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2, active: false }],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
      ],
    });

    await r.completed();

    expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_pack", {
      proration_behavior: "create_prorations",
    });
    expect(r.items.map((i) => i.id)).toEqual(["si_base"]);
    expect(await r.ledger()).toEqual([
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99, sku: undefined },
    ]);
  });

  it("(c) an add-on enabled after the session: ONE Stripe item is created even when two deliveries race", async () => {
    const r = await rig({
      rows: [{ sku: "FORECASTING", quantity: 1 }], // no line in the session
      items: [base()],
    });

    await Promise.all([r.completed(), r.completed()]);

    expect(r.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(r.items.filter((i) => i.metadata?.sku === "FORECASTING")).toHaveLength(1);
    const rows = await r.rows();
    expect(rows[0].stripeItemId).toBe(r.items.find((i) => i.metadata?.sku === "FORECASTING")?.id);
    expect(Number(rows[0].priceSnapshot)).toBe(price.FORECASTING);
    expect((await r.ledger()).filter((e) => e.sku === "FORECASTING")).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: price.FORECASTING, sku: "FORECASTING" },
    ]);
  });
});
