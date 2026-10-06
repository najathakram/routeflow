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
import { ConflictException } from "@nestjs/common";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingService } from "./billing.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { MrrService } from "./mrr.service";
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
  /** The plan-transition hook: off (the plain upsert path) or ON (the transaction + APPLIED marker path). */
  const planTransitionStub = (on: boolean) =>
    ({
      isEnabled: () => Promise.resolve(on),
      prepare: () => Promise.resolve({ enabled: on, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    }) as any;

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

  /** An item of the in-memory Stripe subscription, as dahlia returns it with the product expanded. */
  const stripeItem = (
    id: string,
    o: { sku?: string; cents: number; quantity: number; sub?: string },
  ) => ({
    id,
    object: "subscription_item",
    created: 1791172886,
    current_period_start: 1791172886,
    current_period_end: 1793851286,
    discounts: [],
    metadata: {},
    quantity: o.quantity,
    subscription: o.sub ?? "sub_qa",
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
    mutations: SubscriptionMutationService;
    items: any[];
    stripeClient: any;
    completed: () => Promise<void>;
    sessionId: string;
    ledger: () => Promise<Array<{ type: string; delta: number; sku?: string }>>;
    ledgerSum: () => Promise<number>;
    rows: () => Promise<any[]>;
    /** The mocked Stripe service (module boundary): subscriptions + invoices live in `subs` / `invoices`. */
    stripe: any;
    subs: Record<string, SubState>;
    invoices: Record<string, any>;
    tenantSlug: string;
    /** Deliver ANOTHER checkout.session.completed for this tenant (default: the rig's own session, paid). */
    deliver: (over?: Record<string, unknown>) => Promise<void>;
    /** Register a further Stripe subscription (e.g. the second session's). */
    addSub: (id: string, o: Partial<SubState> & { items: any[] }) => void;
    /** The next `n` Stripe cancelSubscription calls fail with a 500. */
    failNextCancel: (n: number) => void;
    /** A customer.subscription.deleted event for `subId` (Stripe fires it for the duplicate it cancelled). */
    deleted: (subId: string) => Promise<void>;
  }

  interface SubState {
    status: string;
    customer: string;
    latestInvoice: string | null;
    items: any[];
  }

  async function rig(opts: {
    rows: Array<{ sku: string; quantity: number; active?: boolean; isComp?: boolean }>;
    items: any[];
    /** The entitlements.configSnapshot flag (default off). */
    flagOn?: boolean;
    /** The session's customer (default the tenant's own). */
    sessionCustomer?: string;
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
          isComp: r.isComp ?? false,
          priceSnapshot: 0,
        },
      });
    }

    const items = [...opts.items];
    let itemSeq = 0;
    const customer = opts.sessionCustomer ?? "cus_qa";
    // The in-memory Stripe: subscriptions (sub_qa is the rig's own session's) and their invoices.
    const subs: Record<string, SubState> = {
      sub_qa: { status: "active", customer, latestInvoice: "in_qa", items },
    };
    const invoices: Record<string, any> = {
      in_qa: { id: "in_qa", status: "paid", amount_due: 9900, total: 9900 },
    };
    const itemsOf = (subId?: string) => (subId && subs[subId] ? subs[subId].items : items);
    const missing = (what: string) =>
      Object.assign(new Error(`No such ${what}`), { code: "resource_missing" });
    let cancelFailures = 0;
    const stripeClient = {
      products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
      subscriptionItems: {
        list: jest.fn(async (args: any) => ({
          data: itemsOf(args?.subscription).map((i) => ({ ...i })),
        })),
        create: jest.fn(async (args: any) => {
          const item = {
            ...stripeItem(`si_new${++itemSeq}`, { cents: 0, quantity: args.quantity }),
            metadata: args.metadata,
          };
          itemsOf(args?.subscription).push(item);
          return item;
        }),
        update: jest.fn(async (id: string, args: any) => {
          const i = Object.values(subs)
            .flatMap((x) => x.items)
            .find((x) => x.id === id);
          if (i && args?.quantity != null) i.quantity = args.quantity;
          return { id };
        }),
        del: jest.fn(async (id: string) => {
          for (const sub of Object.values(subs)) {
            const i = sub.items.findIndex((x) => x.id === id);
            if (i >= 0) sub.items.splice(i, 1);
          }
          return {};
        }),
      },
      invoiceItems: { list: jest.fn().mockResolvedValue({ data: [] }) },
    };
    const stripe = {
      isConfigured: true,
      client: stripeClient,
      getSubscription: jest.fn(async (id: string) => {
        const sub = subs[id];
        if (!sub) throw missing(`subscription: ${id}`);
        return {
          id,
          object: "subscription",
          status: sub.status,
          customer: sub.customer,
          latest_invoice: sub.latestInvoice,
          items: { object: "list", data: sub.items.map((i) => ({ ...i })) },
        };
      }),
      cancelSubscription: jest.fn(async (id: string) => {
        if (cancelFailures > 0) {
          cancelFailures -= 1;
          throw Object.assign(new Error("Stripe API error (500)"), { type: "StripeAPIError" });
        }
        if (subs[id]) subs[id].status = "canceled";
        return { id, object: "subscription", status: "canceled" };
      }),
      getInvoice: jest.fn(async (id: string) => {
        if (!invoices[id]) throw missing(`invoice: ${id}`);
        return { ...invoices[id] };
      }),
      voidInvoice: jest.fn(async (id: string) => {
        invoices[id].status = "void";
        return { ...invoices[id] };
      }),
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
      planTransitionStub(opts.flagOn ?? false),
    );
    const billing = new BillingService(
      prisma as any,
      stripe,
      stub(),
      { invalidate: jest.fn() } as any,
      events,
      { resolveCatalogPricing: jest.fn().mockResolvedValue({ monthly: 99 }) } as any,
      stub(),
      planTransitionStub(opts.flagOn ?? false),
      mutations,
    );

    const session = {
      id: `cs_qa_${run}_${seq}`,
      object: "checkout.session",
      customer,
      subscription: "sub_qa",
      created: 1791172800,
      payment_status: "paid",
      metadata: { tenantId: tenant.id, planKey: "STARTER", interval: "month" },
    };
    const deliver = (over: Record<string, unknown> = {}) => {
      const s = { ...session, ...over };
      return billing.handleWebhookEvent({
        id: `evt_${s.id}`,
        type: "checkout.session.completed",
        data: { object: s },
      });
    };
    const completed = () => deliver();
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
      mutations,
      items,
      stripeClient,
      completed,
      sessionId: session.id,
      ledger: evs,
      ledgerSum: async () => (await evs()).reduce((s, e) => s + e.delta, 0),
      rows: () =>
        prisma.tenantAddon.findMany({ where: { tenantId: tenant.id }, orderBy: { sku: "asc" } }),
      stripe,
      subs,
      invoices,
      tenantSlug: slug,
      deliver,
      addSub: (id, o) => {
        subs[id] = { status: "active", customer, latestInvoice: null, ...o };
      },
      failNextCancel: (n) => {
        cancelFailures = n;
      },
      deleted: (subId) =>
        billing.handleWebhookEvent({
          id: `evt_deleted_${subId}_${run}`,
          type: "customer.subscription.deleted",
          data: { object: { id: subId, object: "subscription", customer, status: "canceled" } },
        }),
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

  it("a FORGED session (another customer) adopts nothing, writes nothing, resolves, and leaves ONE trail row — flag off and on", async () => {
    for (const flagOn of [false, true]) {
      const r = await rig({
        flagOn,
        sessionCustomer: "cus_attacker",
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });

      await expect(r.completed()).resolves.toBeUndefined();
      await expect(r.completed()).resolves.toBeUndefined(); // a redelivery: still nothing

      expect((await r.rows())[0]).toMatchObject({ stripeItemId: null, quantity: 2 });
      expect(Number((await r.rows())[0].priceSnapshot)).toBe(0);
      expect(await r.ledger()).toEqual([]);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId } })).status).toBe(
        TenantStatus.TRIAL,
      );
      expect(
        (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: r.tenantId } }))
          .stripeSubId,
      ).toBeNull();
      for (const fn of ["create", "update", "del"] as const) {
        expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
      }
      const trail = await prisma.auditLog.findMany({
        where: {
          entityType: "stripe_checkout_session",
          entityId: r.sessionId,
          action: "STRIPE_CHECKOUT_REFUSED",
        },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0].meta).toMatchObject({
        reason: "customer_mismatch",
        storedCustomer: "cus_qa",
        sessionCustomer: "cus_attacker",
        subscriptionId: "sub_qa",
        addonItemIds: ["si_pack"],
      });
    }
  });

  it("flag ON: delivery B hits ALREADY_APPLIED and adopts BEFORE delivery A's crossing — each row adopted and booked exactly once", async () => {
    const r = await rig({
      flagOn: true,
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
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let reached!: () => void;
    const atGate = new Promise<void>((res) => (reached = res));
    const real = (r.billing as any).transitionAndEmit.bind(r.billing);
    jest
      .spyOn(r.billing as any, "transitionAndEmit")
      .mockImplementationOnce(async (...args: any[]) => {
        reached();
        await gate; // A has committed the plan + the APPLIED marker, and waits before the crossing
        return real(...args);
      });

    const a = r.completed();
    await atGate;
    await r.completed(); // B: the marker is there -> ALREADY_APPLIED -> adopts while the tenant is still TRIAL
    expect((await r.rows()).map((x) => x.stripeItemId)).toEqual(["si_pack", "si_fc"]);
    expect(await r.ledger()).toEqual([]); // a non-paying tenant's adoption books nothing (yet)
    release();
    await a;

    // A's crossing prices the base AND the already-adopted add-ons at their stored (actual) snapshots,
    // once; A's own adoption finds both items set and does nothing
    expect(await r.ledger()).toEqual([
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99 + 100 + 19, sku: undefined },
    ]);
    expect(await r.ledgerSum()).toBe(218);
    expect(
      (await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot), x.quantity]),
    ).toEqual([
      ["si_pack", 50, 2],
      ["si_fc", 19, 1],
    ]);
    for (const fn of ["create", "update", "del"] as const) {
      expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
    }
  });

  it("two concurrent ensureStripeCustomer calls (no customer yet) create ONE Stripe customer under the billing lock", async () => {
    seq += 1;
    const slug = assertTestTenant(`qa-optA-${run}-${seq}`, "trial-addon-checkout.db.spec.ts");
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.TRIAL },
    });
    tenantIds.push(tenant.id);
    await prisma.tenantSubscription.create({ data: { tenantId: tenant.id, discount: 0 } as any });
    let n = 0;
    const stripe = {
      isConfigured: true,
      createCustomer: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 50)); // a real network hop: the other caller interleaves here
        return { id: `cus_qa_${run}_${++n}` };
      }),
    } as any;
    const billing = new BillingService(
      prisma as any,
      stripe,
      stub(),
      { invalidate: jest.fn() } as any,
      new BillingEventService(prisma as any),
      stub(),
      stub(),
      planTransitionStub(false),
      stub(),
    );

    const ids = await Promise.all([
      billing.ensureStripeCustomer(tenant.id),
      billing.ensureStripeCustomer(tenant.id),
    ]);

    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(ids[0]).toBe(ids[1]);
    expect(
      (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } }))
        .stripeCustomerId,
    ).toBe(ids[0]);
  });

  it("SA-693: a COMP is never billed — its checkout item is deleted, a comp with no line gets no item, a billable row of the same completion is adopted", async () => {
    const r = await rig({
      rows: [
        { sku: "CUSTOMER_PACK_100", quantity: 2 }, // billable
        { sku: "FORECASTING", quantity: 1, isComp: true }, // comp WITH a checkout item (row turned comp after the session)
        { sku: "MSRP", quantity: 1, isComp: true }, // comp without a line (not self-serve either)
      ],
      items: [
        base(),
        stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        stripeItem("si_fc", { sku: "FORECASTING", cents: 1900, quantity: 1 }),
      ],
    });

    await r.completed();

    const rows = await r.rows();
    expect(rows.map((x) => [x.sku, x.isComp, x.stripeItemId, Number(x.priceSnapshot)])).toEqual([
      ["CUSTOMER_PACK_100", false, "si_pack", 50],
      ["FORECASTING", true, null, 0],
      ["MSRP", true, null, 0],
    ]);
    expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_fc", {
      proration_behavior: "create_prorations",
    });
    expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    expect(await r.ledger()).toEqual([
      { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99, sku: undefined },
      { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
    ]);
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

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // X1 — a STALE checkout never completes over a newer billing state.
  // Real Postgres; only Stripe is mocked (module boundary: subscriptions, invoices, cancel/void).
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("X1: a stale checkout never completes over a newer billing state (real Postgres)", () => {
    const pack = () =>
      stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 });
    const dupItems = () => [
      stripeItem("si_dup_base", { cents: 9900, quantity: 1, sub: "sub_dup" }),
      stripeItem("si_dup_pack", {
        sku: "CUSTOMER_PACK_100",
        cents: 5000,
        quantity: 2,
        sub: "sub_dup",
      }),
    ];
    /** A tenant whose own session (sub_qa) and a second, already-paid session (sub_dup) both exist in Stripe. */
    async function twoSessions(flagOn = false, paid = true) {
      const r = await rig({
        flagOn,
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [base(), pack()],
      });
      r.addSub("sub_dup", { items: dupItems(), latestInvoice: "in_dup" });
      r.invoices.in_dup = {
        id: "in_dup",
        status: paid ? "paid" : "open",
        amount_due: 19900,
        total: 19900,
      };
      return r;
    }
    const dupSession = (r: Rig, over: Record<string, unknown> = {}) => ({
      id: `${r.sessionId}_dup`,
      subscription: "sub_dup",
      ...over,
    });
    const decisions = (r: Rig) =>
      prisma.auditLog.findMany({
        where: { tenantId: r.tenantId, action: "STRIPE_CHECKOUT_DUPLICATE" },
      });
    const notices = (r: Rig) =>
      prisma.auditLog.findMany({
        where: { tenantId: r.tenantId, action: "STRIPE_DUPLICATE_CHECKOUT" },
      });
    const sub = (r: Rig) =>
      prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: r.tenantId } });
    const tenantStatus = async (r: Rig) =>
      (await prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId } })).status;
    const cancelArgs = (r: Rig) => [
      "sub_dup",
      { prorate: false, invoice_now: false },
      { idempotencyKey: `cancel-dup:${r.sessionId}_dup` },
    ];
    const noItemWrites = (r: Rig) => {
      for (const fn of ["create", "update", "del"] as const) {
        expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
      }
    };
    const NOTICE = (r: Rig, paid = true) =>
      paid
        ? `Duplicate checkout for ${r.tenantSlug} — first invoice in_dup on sub_dup was charged; refund it in Stripe.`
        : `Duplicate checkout for ${r.tenantSlug} — first invoice in_dup on sub_dup was not paid and is voided; nothing to refund.`;
    const platformAdmin = (flagOn: boolean) =>
      new PlatformAdminService(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
        { syncStripeSubscriptionPrice: jest.fn().mockResolvedValue(undefined) } as any,
        { resolveTenantPricing: jest.fn().mockResolvedValue({}) } as any,
        catalog,
        {} as any,
        {} as any,
        new BillingEventService(prisma as any),
        {} as any,
        { invalidate: jest.fn() } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
        new MrrService(prisma as any),
        {} as any,
        {} as any,
        planTransitionStub(flagOn),
      );
    const activateManually = (flagOn: boolean, tenantId: string) =>
      platformAdmin(flagOn).activateManualSubscription(
        tenantId,
        {
          plan: "STARTER",
          paymentMethod: "ZELLE",
          paymentRef: `ref-x1-${run}`,
          billingPeriodDays: 30,
        } as any,
        "admin-1",
      );
    const hourAgo = () => Math.floor(Date.now() / 1000) - 3600;

    it.each([false, true])(
      "1 (flag on=%s): two sessions both complete — the stored sub is unchanged, sub 2 is cancelled ONCE (prorate false), exactly 1 notice + 1 decision row, no add-on adopted from it, no MRR",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        await r.completed(); // session 1: applied
        const rowsAfterFirst = (await r.rows()).map((x) => [
          x.stripeItemId,
          Number(x.priceSnapshot),
        ]);
        const ledgerAfterFirst = await r.ledger();
        expect(rowsAfterFirst).toEqual([["si_pack", 50]]);

        await r.deliver(dupSession(r)); // session 2: paid, a duplicate

        expect((await sub(r)).stripeSubId).toBe("sub_qa"); // never re-pointed
        expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
        expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
        expect(r.stripe.cancelSubscription).toHaveBeenCalledWith(...cancelArgs(r));
        expect(r.subs.sub_dup.status).toBe("canceled");
        expect(r.stripe.voidInvoice).not.toHaveBeenCalled(); // a paid session voids nothing
        const decided = await decisions(r);
        expect(decided).toHaveLength(1);
        expect(decided[0]).toMatchObject({ entityId: `${r.sessionId}_dup`, tenantId: r.tenantId });
        expect(decided[0].meta).toMatchObject({
          reason: "duplicate_checkout",
          subscriptionId: "sub_dup",
          storedSubscriptionId: "sub_qa",
          latestInvoice: "in_dup",
          invoiceAmountCents: 19900,
          invoicePaid: true,
        });
        const told = await notices(r);
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({ entityType: "tenant", entityId: r.tenantId });
        expect((told[0].meta as any).message).toBe(NOTICE(r));
        // the duplicate's add-on item was never adopted, touched or deleted; nothing booked
        expect((await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)])).toEqual(
          rowsAfterFirst,
        );
        noItemWrites(r);
        expect(await r.ledger()).toEqual(ledgerAfterFirst);
      },
    );

    it.each([false, true])(
      "2 (flag on=%s): session created -> MANUAL activation -> session paid: the session is not applied; sub cancelled once, 1 notice, 1 decision, no add-on adopted, no MRR from it",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
          items: [base(), pack()],
        });
        r.invoices.in_qa = { id: "in_qa", status: "paid", amount_due: 19900, total: 19900 };
        const created = hourAgo(); // the session exists BEFORE the owner moves the tenant to manual invoicing
        await activateManually(flagOn, r.tenantId);
        const afterActivation = await r.ledger();
        const manualRows = (await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)]);
        expect(manualRows).toEqual([[null, price.CUSTOMER_PACK_100]]); // priced for the owner's invoice

        await r.deliver({ created }); // ...and now the customer's card checkout is paid

        const row = await sub(r);
        expect(row.stripeSubId).toBeNull(); // not re-pointed at the checkout's subscription
        expect(row.externalPayment).toBe(true);
        expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
        expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
        expect(r.stripe.cancelSubscription).toHaveBeenCalledWith(
          "sub_qa",
          {
            prorate: false,
            invoice_now: false,
          },
          { idempotencyKey: `cancel-dup:${r.sessionId}` },
        );
        const decided = await decisions(r);
        expect(decided).toHaveLength(1);
        expect(decided[0].meta).toMatchObject({ reason: "stale_checkout_manual" });
        const told = await notices(r);
        expect(told).toHaveLength(1);
        expect((told[0].meta as any).message).toBe(
          `Duplicate checkout for ${r.tenantSlug} — first invoice in_qa on sub_qa was charged; refund it in Stripe.`,
        );
        expect((await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)])).toEqual(
          manualRows,
        );
        noItemWrites(r);
        expect(await r.ledger()).toEqual(afterActivation); // the session booked nothing
        // Stripe then reports the cancelled subscription deleted: the manual tenant stays ACTIVE
        await r.deleted("sub_qa");
        expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
        expect(await r.ledger()).toEqual(afterActivation);
      },
    );

    it("3: a REDELIVERY of the duplicate session — no second cancel, no second notice, no second decision row", async () => {
      const r = await twoSessions();
      await r.completed();
      await r.deliver(dupSession(r));
      await r.deliver(dupSession(r));
      await r.deliver(dupSession(r));

      expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(await decisions(r)).toHaveLength(1);
      expect(await notices(r)).toHaveLength(1);
      expect((await sub(r)).stripeSubId).toBe("sub_qa");
    });

    it("3b: the cancel failed — the decision + notice STAND, the redelivery ONLY retries the cancel and never re-judges (even though the stored sub has since died)", async () => {
      const r = await twoSessions();
      await r.completed();
      r.failNextCancel(1);

      await expect(r.deliver(dupSession(r))).rejects.toThrow(/Stripe API error/);
      expect(await decisions(r)).toHaveLength(1);
      expect(await notices(r)).toHaveLength(1);
      expect(r.subs.sub_dup.status).toBe("active"); // still billing: the retry must cancel it

      // the stored subscription dies in the meantime: a RE-JUDGEMENT would now apply the duplicate
      r.subs.sub_qa.status = "canceled";
      await expect(r.deliver(dupSession(r))).resolves.toBeUndefined();

      expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(2); // the failed one + the retry
      for (const call of r.stripe.cancelSubscription.mock.calls) {
        expect(call).toEqual(cancelArgs(r)); // the SAME idempotency key both times
      }
      expect(r.subs.sub_dup.status).toBe("canceled");
      expect(await decisions(r)).toHaveLength(1);
      expect(await notices(r)).toHaveLength(1);
      expect((await sub(r)).stripeSubId).toBe("sub_qa"); // never adopted
      noItemWrites(r);
    });

    it("5: an UNPAID session also voids the duplicate's open first invoice, and the notice says nothing is owed", async () => {
      const r = await twoSessions(false, false);
      await r.completed();

      await r.deliver(dupSession(r, { payment_status: "unpaid" }));

      expect(r.stripe.voidInvoice).toHaveBeenCalledTimes(1);
      expect(r.stripe.voidInvoice).toHaveBeenCalledWith("in_dup");
      expect(r.invoices.in_dup.status).toBe("void");
      expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
      const told = await notices(r);
      expect(told).toHaveLength(1);
      expect((told[0].meta as any).message).toBe(NOTICE(r, false));
      expect((told[0].meta as any).invoicePaid).toBe(false);
      // a redelivery voids nothing more (the invoice is no longer open)
      await r.deliver(dupSession(r, { payment_status: "unpaid" }));
      expect(r.stripe.voidInvoice).toHaveBeenCalledTimes(1);
      expect(await notices(r)).toHaveLength(1);
    });

    it("6: the duplicate's own customer.subscription.deleted leaves the tenant ACTIVE on its first subscription, books no churn", async () => {
      const r = await twoSessions();
      await r.completed();
      await r.deliver(dupSession(r));
      const ledger = await r.ledger();

      await r.deleted("sub_dup");

      expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
      expect((await sub(r)).stripeSubId).toBe("sub_qa");
      expect(await r.ledger()).toEqual(ledger);
    });

    it.each(["active", "trialing", "past_due", "unpaid"])(
      "4: a stored subscription that is %s at Stripe is LIVE — the new session is a duplicate",
      async (status) => {
        const r = await twoSessions();
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: { stripeSubId: "sub_old" },
        });
        r.addSub("sub_old", { items: [], status });

        await r.completed();

        expect((await sub(r)).stripeSubId).toBe("sub_old");
        expect(r.stripe.cancelSubscription).toHaveBeenCalledWith("sub_qa", expect.anything(), {
          idempotencyKey: `cancel-dup:${r.sessionId}`,
        });
        expect(await decisions(r)).toHaveLength(1);
        expect(await notices(r)).toHaveLength(1);
        expect((await r.rows())[0]).toMatchObject({ stripeItemId: null });
      },
    );

    it.each(["canceled", "incomplete", "incomplete_expired"])(
      "4: a stored subscription that is %s at Stripe is NOT live — a fresh checkout completes normally",
      async (status) => {
        const r = await twoSessions();
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: { stripeSubId: "sub_old" },
        });
        r.addSub("sub_old", { items: [], status });

        await r.completed();

        expect((await sub(r)).stripeSubId).toBe("sub_qa");
        expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        expect(await decisions(r)).toHaveLength(0);
        expect(await notices(r)).toHaveLength(0);
        expect((await r.rows())[0]).toMatchObject({ stripeItemId: "si_pack" });
      },
    );

    it("4: a stored subscription Stripe no longer knows is not live either", async () => {
      const r = await twoSessions();
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { stripeSubId: "sub_gone" },
      });

      await r.completed();

      expect((await sub(r)).stripeSubId).toBe("sub_qa");
      expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
    });

    it("4 (happy path unchanged): one session, no stored subscription — applied, adopted, booked; no cancel, no decision, no notice", async () => {
      const r = await twoSessions();

      await r.completed();
      await r.completed(); // and its redelivery

      expect((await sub(r)).stripeSubId).toBe("sub_qa");
      expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
      expect(await r.ledgerSum()).toBe(99 + 100);
      expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(r.stripe.voidInvoice).not.toHaveBeenCalled();
      expect(await decisions(r)).toHaveLength(0);
      expect(await notices(r)).toHaveLength(0);
    });

    it("a manual activation from BEFORE the session (the owner then asked the customer to pay by card) completes normally", async () => {
      const r = await twoSessions();
      const created = hourAgo();
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { externalPayment: true, periodStart: new Date((created - 7200) * 1000) },
      });

      await r.deliver({ created });

      expect((await sub(r)).stripeSubId).toBe("sub_qa");
      expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(await decisions(r)).toHaveLength(0);
    });

    it.each([false, true])(
      "RACE (flag on=%s): the stored id moved between the early read and the tenant lock — a retryable conflict with nothing written; the redelivery is then judged a duplicate",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        let release!: () => void;
        const gate = new Promise<void>((res) => (release = res));
        let parked!: () => void;
        const atGate = new Promise<void>((res) => (parked = res));
        const real = (r.billing as any).hasDuplicateDecision.bind(r.billing);
        let hold = true;
        jest
          .spyOn(r.billing as any, "hasDuplicateDecision")
          .mockImplementation(async (key: string) => {
            if (hold && key === `${r.sessionId}_dup`) {
              parked();
              await gate; // session 2 has READ the tenant (no stored sub) and now waits
            }
            return real(key);
          });

        const second = r.deliver(dupSession(r));
        await atGate;
        await r.completed(); // session 1 applies in full while session 2 is parked
        release();
        await expect(second).rejects.toBeInstanceOf(ConflictException);

        // the loser wrote nothing and cancelled nothing
        expect((await sub(r)).stripeSubId).toBe("sub_qa");
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        expect(await decisions(r)).toHaveLength(0);
        const ledger = await r.ledger();
        expect(ledger.filter((e) => e.type === BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toHaveLength(
          1,
        );

        hold = false;
        await r.deliver(dupSession(r)); // Stripe redelivers: now a plain duplicate
        expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
        expect(r.stripe.cancelSubscription).toHaveBeenCalledWith(...cancelArgs(r));
        expect(await decisions(r)).toHaveLength(1);
        expect(await notices(r)).toHaveLength(1);
        expect(await r.ledger()).toEqual(ledger);
        noItemWrites(r);
      },
    );

    it.each([false, true])(
      "RACE (flag on=%s): a MANUAL activation commits between the early read and the tenant lock — re-judged under the lock, nothing written, the session is cancelled + noticed",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        const created = hourAgo();
        let release!: () => void;
        const gate = new Promise<void>((res) => (release = res));
        let parked!: () => void;
        const atGate = new Promise<void>((res) => (parked = res));
        const real = (r.billing as any).hasDuplicateDecision.bind(r.billing);
        jest
          .spyOn(r.billing as any, "hasDuplicateDecision")
          .mockImplementation(async (k: string) => {
            parked();
            await gate; // the session has read the tenant (not manual) and waits
            return real(k);
          });

        const completion = r.deliver({ created });
        await atGate;
        await activateManually(flagOn, r.tenantId); // commits while the completion is parked
        const afterActivation = await r.ledger();
        release();
        await expect(completion).resolves.toBeUndefined();

        expect((await sub(r)).stripeSubId).toBeNull();
        expect(await tenantStatus(r)).toBe(TenantStatus.ACTIVE);
        expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
        expect((await decisions(r))[0].meta).toMatchObject({ reason: "stale_checkout_manual" });
        expect(await notices(r)).toHaveLength(1);
        expect(await r.ledger()).toEqual(afterActivation);
        noItemWrites(r);
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // MUST-1 — a LAPSED trial (READ_ONLY + trial_expired / trial_cancelled) keeps its add-ons.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("MUST-1: a lapsed trial keeps its add-ons across the plan pick and the checkout bills them (real Postgres)", () => {
    const lapse = (tenantId: string, readOnlyReason: string | null) =>
      prisma.tenant.update({
        where: { id: tenantId },
        data: { status: TenantStatus.READ_ONLY, readOnlyReason },
      });

    it.each(["trial_expired", "trial_cancelled"])(
      "READ_ONLY + %s: subscribe({planKey, cycle}) keeps the rows active and unbilled, and checkoutAddonLines bills them",
      async (reason) => {
        const r = await rig({
          rows: [
            { sku: "CUSTOMER_PACK_100", quantity: 2 },
            { sku: "FORECASTING", quantity: 1 },
          ],
          items: [base()],
        });
        await lapse(r.tenantId, reason);

        await r.mutations.subscribe(
          r.tenantId,
          { planKey: "STARTER", cycle: "MONTHLY" },
          "admin-1",
        );

        expect((await r.rows()).map((x) => [x.sku, x.active, x.stripeItemId, x.quantity])).toEqual([
          ["CUSTOMER_PACK_100", true, null, 2],
          ["FORECASTING", true, null, 1],
        ]);
        const lines = await r.mutations.checkoutAddonLines(r.tenantId, "month");
        expect(lines.skus).toEqual(["CUSTOMER_PACK_100", "FORECASTING"]);
        expect(lines.lineItems.map((l: any) => l.quantity)).toEqual([2, 1]);
      },
    );

    it("READ_ONLY with another reason (a cancelled paid subscription) is not a trial: the omitted add-ons are dropped", async () => {
      const r = await rig({ rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }], items: [base()] });
      await lapse(r.tenantId, "subscription_cancelled");

      await r.mutations.subscribe(r.tenantId, { planKey: "STARTER", cycle: "MONTHLY" }, "admin-1");

      expect((await r.rows()).map((x) => [x.sku, x.active])).toEqual([
        ["CUSTOMER_PACK_100", false],
      ]);
    });
  });
});
