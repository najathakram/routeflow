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
import { BillingCronService } from "./billing-cron.service";
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
      // refusal trail rows of a session with no tenant row to point at carry a NULL tenantId
      await prisma.auditLog.deleteMany({
        where: { entityType: "stripe_checkout_session", entityId: { startsWith: `cs_qa_${run}_` } },
      });
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
    rows: Array<{
      sku: string;
      quantity: number;
      active?: boolean;
      isComp?: boolean;
      priceSnapshot?: number;
      stripeItemId?: string;
    }>;
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
          priceSnapshot: r.priceSnapshot ?? 0,
          stripeItemId: r.stripeItemId ?? null,
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
  const tenantStatusOf = async (tenantId: string) =>
    (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status;

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

    it.each([false, true])(
      "S2 (flag on=%s): A applied, sub_A cancelled, B applied, then a LATE retry of A — no verdict, no cancel, no refund notice, stored sub stays B",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        await r.completed(); // session A applied (stored = sub_qa)
        r.subs.sub_qa.status = "canceled"; // the customer cancelled A
        await r.deleted("sub_qa");
        await r.deliver(dupSession(r)); // session B (sub_dup): the stored sub is dead, so it applies
        expect((await sub(r)).stripeSubId).toBe("sub_dup");
        const ledger = await r.ledger();
        const before = await prisma.auditLog.count({ where: { tenantId: r.tenantId } });

        await r.completed(); // A's webhook retried, late
        await r.completed();

        expect((await sub(r)).stripeSubId).toBe("sub_dup"); // never pointed back at the dead sub_A
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        expect(r.stripe.voidInvoice).not.toHaveBeenCalled();
        expect(await decisions(r)).toHaveLength(0);
        expect(await notices(r)).toHaveLength(0); // no false "refund it in Stripe"
        expect(await prisma.auditLog.count({ where: { tenantId: r.tenantId } })).toBe(before);
        expect(await r.ledger()).toEqual(ledger);
      },
    );

    it.each([false, true])(
      "S2 carry (flag on=%s): a PAID session whose own subscription is already cancelled and that was never applied — nothing applied, ONE trail row + ONE admin notice however often it is redelivered",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
          items: [
            base(),
            stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
          ],
        });
        r.subs.sub_qa.status = "canceled";

        await r.deliver({ payment_status: "paid" });
        await r.deliver({ payment_status: "paid" });
        await r.deliver({ payment_status: "paid" });

        expect((await prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId } })).status).toBe(
          TenantStatus.TRIAL,
        );
        expect((await sub(r)).stripeSubId).toBeNull();
        expect((await r.rows())[0]).toMatchObject({ stripeItemId: null });
        expect(await r.ledger()).toEqual([]);
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        const trail = await prisma.auditLog.findMany({
          where: {
            entityType: "stripe_checkout_session",
            entityId: r.sessionId,
            action: "STRIPE_CHECKOUT_REFUSED",
          },
        });
        expect(trail).toHaveLength(1);
        expect(trail[0].meta).toMatchObject({ reason: "subscription_already_cancelled" });
        const told = await prisma.auditLog.findMany({
          where: { tenantId: r.tenantId, action: "STRIPE_PAID_CHECKOUT_NOT_APPLIED" },
        });
        expect(told).toHaveLength(1);
        expect(told[0].meta).toMatchObject({
          reason: "subscription_already_cancelled",
          subscriptionId: "sub_qa",
          message: expect.stringContaining("was already cancelled when the completion arrived"),
        });
      },
    );

    it.each([false, true])(
      "S2 carry RACE (flag on=%s): B commits between A's early read and A's per-SKU adopt — the re-read under the add-on lock writes nothing; B's items stay owned",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        await r.completed(); // A applied: the row owns si_pack
        const ledger = await r.ledger();
        for (const fn of ["create", "update", "del"] as const) {
          r.stripeClient.subscriptionItems[fn].mockClear();
        }
        const real = (r.mutations as any).runUnderAddonLock.bind(r.mutations);
        jest
          .spyOn(r.mutations as any, "runUnderAddonLock")
          .mockImplementation(async (...a: any[]) => {
            // B commits HERE: it is stored now, and the row owns B's item
            await prisma.tenantSubscription.update({
              where: { tenantId: r.tenantId },
              data: { stripeSubId: "sub_dup" },
            });
            await prisma.tenantAddon.updateMany({
              where: { tenantId: r.tenantId },
              data: { stripeItemId: "si_dup_pack", priceSnapshot: 50 },
            });
            return real(...a);
          });

        await r.completed(); // A redelivered

        for (const fn of ["create", "update", "del"] as const) {
          expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
        }
        expect((await sub(r)).stripeSubId).toBe("sub_dup");
        expect((await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)])).toEqual([
          ["si_dup_pack", 50],
        ]);
        expect(await r.ledger()).toEqual(ledger);
      },
    );

    it("S2: a session that already has its APPLIED row is an idempotent redelivery even when a different live subscription is stored now", async () => {
      const r = await twoSessions(true);
      await r.completed(); // A applied (APPLIED row written)
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { stripeSubId: "sub_dup" }, // a different, live subscription is stored NOW
      });

      // the live active rows now point at sub_dup's items (B's), as they would after B was applied
      await prisma.tenantAddon.updateMany({
        where: { tenantId: r.tenantId },
        data: { stripeItemId: "si_dup_pack", priceSnapshot: 50 },
      });
      const ledger = await r.ledger();

      await r.completed(); // A redelivered, its own subscription still active

      expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(await decisions(r)).toHaveLength(0);
      expect(await notices(r)).toHaveLength(0);
      expect((await sub(r)).stripeSubId).toBe("sub_dup");
      // ...and the adoption did NOT run against sub_A: no item created or touched anywhere, B's pointers stay
      for (const fn of ["create", "update", "del"] as const) {
        expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
      }
      expect((await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)])).toEqual([
        ["si_dup_pack", 50],
      ]);
      expect(await r.ledger()).toEqual(ledger);
    });

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

    /** The in-transaction marker of a manual activation, committed at `atS` (unix seconds). */
    const insertMarker = (tenantId: string, atS: number) =>
      prisma.auditLog.create({
        data: {
          tenantId,
          action: "TENANT_MANUAL_ACTIVATION_MARKER",
          entityType: "tenant",
          entityId: tenantId,
          createdAt: new Date(atS * 1000),
          meta: { platformAdmin: true },
        },
      });
    const markerRows = (tenantId: string) =>
      prisma.auditLog.findMany({
        where: { tenantId, action: "TENANT_MANUAL_ACTIVATION_MARKER" },
      });
    /** The billing cron's REAL rollCycles, confined to one tenant (the shared scratch DB holds others). */
    const rollCyclesFor = (tenantId: string) => {
      const scoped = {
        tenantSubscription: {
          findMany: (args: any) =>
            prisma.tenantSubscription.findMany({ ...args, where: { ...args.where, tenantId } }),
          update: (args: any) => prisma.tenantSubscription.update(args),
        },
      };
      return new BillingCronService(
        scoped as any,
        stub(),
        stub(),
        stub(),
        catalog,
        stub(),
        stub(),
        planTransitionStub(false),
      ).rollCycles();
    };

    it("a manual activation from well BEFORE the session (the owner then asked the customer to pay by card) completes normally", async () => {
      const r = await twoSessions();
      const created = hourAgo();
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { externalPayment: true },
      });
      await insertMarker(r.tenantId, created - 7200); // two hours before the session

      await r.deliver({ created });

      expect((await sub(r)).stripeSubId).toBe("sub_qa");
      expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(await decisions(r)).toHaveLength(0);
    });

    it.each([false, true])(
      "S3 (flag on=%s): a cron rollCycles between session creation and completion moves periodStart past the session but is NOT a manual activation — the session APPLIES, no cancel",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        const created = Math.floor(Date.now() / 1000) - 2 * 3600; // the session was created two hours ago
        const now = Date.now();
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: {
            externalPayment: true,
            planKey: "STARTER",
            cycle: "MONTHLY",
            periodStart: new Date(now - 31 * 86_400_000),
            periodEnd: new Date(now - 3_600_000), // ended an hour ago: the cron rolls it
          },
        });
        await insertMarker(r.tenantId, created - 3 * 86_400); // activated three days before the session

        await rollCyclesFor(r.tenantId);

        const rolled = await sub(r);
        expect(rolled.periodStart!.getTime()).toBeGreaterThan(created * 1000); // the OLD proxy's trigger
        await r.deliver({ created });

        expect((await sub(r)).stripeSubId).toBe("sub_qa");
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        expect(await decisions(r)).toHaveLength(0);
        expect(await notices(r)).toHaveLength(0);
        expect((await r.rows())[0]).toMatchObject({ stripeItemId: "si_pack" });
      },
    );

    /** The legacy post-commit trail row of a manual activation (the only record from before the marker existed). */
    const insertTrail = (tenantId: string, atS: number) =>
      prisma.auditLog.create({
        data: {
          tenantId,
          action: "TENANT_SUBSCRIPTION_ACTIVATED",
          entityType: "tenant",
          entityId: tenantId,
          createdAt: new Date(atS * 1000),
          meta: { platformAdmin: true },
        },
      });

    it.each([false, true])(
      "S3 carry (a, flag on=%s): NO marker, a legacy trail row long BEFORE the session, then a cron rollCycles after it — completes (applied, no cancel)",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        const created = Math.floor(Date.now() / 1000) - 2 * 3600;
        const now = Date.now();
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: {
            externalPayment: true,
            planKey: "STARTER",
            cycle: "MONTHLY",
            periodStart: new Date(now - 31 * 86_400_000),
            periodEnd: new Date(now - 3_600_000),
          },
        });
        await insertTrail(r.tenantId, created - 3 * 86_400);
        await rollCyclesFor(r.tenantId);
        expect((await sub(r)).periodStart!.getTime()).toBeGreaterThan(created * 1000);
        expect(await markerRows(r.tenantId)).toHaveLength(0);

        await r.deliver({ created });

        expect((await sub(r)).stripeSubId).toBe("sub_qa");
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        expect(await decisions(r)).toHaveLength(0);
        expect(await notices(r)).toHaveLength(0);
      },
    );

    it.each([false, true])(
      "S3 carry (b, flag on=%s): NO marker, a legacy trail row AFTER the session — stale: cancel + notice, nothing applied",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        const created = Math.floor(Date.now() / 1000) - 3600;
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: { externalPayment: true },
        });
        await insertTrail(r.tenantId, created + 600);

        await r.deliver({ created });

        expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
        expect((await decisions(r))[0].meta).toMatchObject({ reason: "stale_checkout_manual" });
        expect(await notices(r)).toHaveLength(1);
        expect((await sub(r)).stripeSubId).toBeNull();
        expect((await r.rows())[0]).toMatchObject({ stripeItemId: null });
      },
    );

    it.each([false, true])(
      "S3 carry (c, flag on=%s): externalPayment but NEITHER a marker nor a trail row — completes",
      async (flagOn) => {
        const r = await twoSessions(flagOn);
        const created = Math.floor(Date.now() / 1000) - 3600;
        const now = Date.now();
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: {
            externalPayment: true,
            periodStart: new Date(now - 60_000), // moved after the session by something other than an activation
          },
        });

        await r.deliver({ created });

        expect((await sub(r)).stripeSubId).toBe("sub_qa");
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
        expect(await notices(r)).toHaveLength(0);
      },
    );

    it.each([
      [30, true],
      [59, true],
      [61, false],
    ])("S3 skew: a marker %i s before session.created is %s", async (secondsBefore, stale) => {
      const r = await twoSessions();
      const created = Math.floor(Date.now() / 1000) - 600;
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { externalPayment: true },
      });
      await insertMarker(r.tenantId, created - secondsBefore);

      await r.deliver({ created });

      expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(stale ? 1 : 0);
      expect((await sub(r)).stripeSubId).toBe(stale ? null : "sub_qa");
      expect(await notices(r)).toHaveLength(stale ? 1 : 0);
    });

    it("S3: the REAL activation commits its marker with the activation, so a completion re-judging afterwards is stale (cancel + notice); a manual RENEWAL after the session counts too", async () => {
      const r = await twoSessions();
      const created = Math.floor(Date.now() / 1000) - 3600;
      await insertMarker(r.tenantId, created - 7 * 86_400); // an old activation, a week before the session
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { externalPayment: true },
      });

      await activateManually(false, r.tenantId); // the renewal, after the session

      const markers = await markerRows(r.tenantId);
      expect(markers).toHaveLength(2);
      expect(markers.map((m) => m.entityId)).toEqual([r.tenantId, r.tenantId]);
      await r.deliver({ created });

      expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
      expect((await decisions(r))[0].meta).toMatchObject({ reason: "stale_checkout_manual" });
      expect(await notices(r)).toHaveLength(1);
      expect((await sub(r)).stripeSubId).toBeNull();
    });

    it("S3: a failing activation leaves NO marker (it is written in the activation's transaction)", async () => {
      const r = await twoSessions();
      const failing = platformAdmin(false);
      // an unknown plan is refused before the transaction; force a failure INSIDE it instead
      jest
        .spyOn((failing as any).billingEventService, "emit")
        .mockRejectedValueOnce(new Error("ledger down"));

      await expect(
        failing.activateManualSubscription(
          r.tenantId,
          {
            plan: "STARTER",
            paymentMethod: "ZELLE",
            paymentRef: "x",
            billingPeriodDays: 30,
          } as any,
          "admin-1",
        ),
      ).rejects.toThrow("ledger down");

      expect(await markerRows(r.tenantId)).toHaveLength(0);
      expect((await sub(r)).externalPayment).toBe(false);
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

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // MUST-2 — a lost compare-and-swap in path (c) fails the webhook; nothing is left unowned.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("MUST-2: a lost compare-and-swap in path (c) fails the webhook and leaves no unowned item (real Postgres)", () => {
    it.each([false, true])(
      "(flag on=%s) the row changes after the item is created: the created item is deleted, the webhook fails, nothing is booked; the retry adopts exactly one item",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [{ sku: "FORECASTING", quantity: 1 }], // enabled after the session: no line, no item
          items: [base()],
        });
        r.stripeClient.subscriptionItems.create.mockImplementationOnce(async (args: any) => {
          // a concurrent writer raises the quantity while the item is being created
          await prisma.tenantAddon.updateMany({
            where: { tenantId: r.tenantId },
            data: { quantity: 3 },
          });
          const item = {
            ...stripeItem("si_made", { cents: 0, quantity: args.quantity }),
            metadata: args.metadata,
          };
          r.items.push(item);
          return item;
        });

        await expect(r.completed()).rejects.toBeInstanceOf(ConflictException);

        expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_made", {
          proration_behavior: "create_prorations",
        });
        expect(r.items.map((i) => i.id)).toEqual(["si_base"]); // nothing unowned left billing
        expect((await r.rows())[0]).toMatchObject({ stripeItemId: null, quantity: 3 });
        expect(Number((await r.rows())[0].priceSnapshot)).toBe(0);
        expect((await r.ledger()).filter((e) => e.sku === "FORECASTING")).toEqual([]);

        await r.completed(); // Stripe redelivers: the row is read afresh and billed once

        const row = (await r.rows())[0];
        expect(row.stripeItemId).toBeTruthy();
        expect(Number(row.priceSnapshot)).toBe(price.FORECASTING);
        expect(row.quantity).toBe(3);
        expect(r.items.filter((i) => i.metadata?.sku === "FORECASTING")).toHaveLength(1);
        expect((await r.ledger()).filter((e) => e.sku === "FORECASTING")).toEqual([
          { type: BILLING_EVENTS.ADDON_ENABLED, delta: price.FORECASTING * 3, sku: "FORECASTING" },
        ]);
      },
    );

    it("an ADOPTED unreferenced item on a lost compare-and-swap fails the webhook and is not deleted by it", async () => {
      const lost = {
        ...stripeItem("si_lost", { cents: 5000, quantity: 2 }),
        metadata: { sku: "CUSTOMER_PACK_100" },
      };
      const r = await rig({
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [base(), lost],
      });
      lost.metadata = { tenantId: r.tenantId, sku: "CUSTOMER_PACK_100" } as any; // an in-app enable item of this tenant
      r.stripeClient.subscriptionItems.list.mockImplementationOnce(async () => {
        await prisma.tenantAddon.updateMany({
          where: { tenantId: r.tenantId },
          data: { quantity: 4 },
        });
        return { data: r.items.map((i: any) => ({ ...i })) };
      });

      await expect(r.completed()).rejects.toBeInstanceOf(ConflictException);

      expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
      expect(r.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
      expect((await r.rows())[0]).toMatchObject({ stripeItemId: null, quantity: 4 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // S4 refinement — a TRANSIENT unreadable item throws; a PERMANENT quantity below 1 is cleaned up.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("S4: transient unreadable throws a coded refusal; a quantity below 1 is deleted + announced, never thrown (real Postgres)", () => {
    const unusable = (tenantId: string) =>
      prisma.auditLog.findMany({
        where: { tenantId, action: "ADDON_CHECKOUT_ITEM_UNUSABLE" },
      });

    it("TRANSIENT: an item with no readable unit amount refuses the webhook with ADDON_CHECKOUT_ITEM_UNREADABLE, nothing deleted, no notice", async () => {
      const noPrice: any = stripeItem("si_pack", {
        sku: "CUSTOMER_PACK_100",
        cents: 5000,
        quantity: 2,
      });
      noPrice.price = { ...noPrice.price, unit_amount: null, unit_amount_decimal: null };
      const r = await rig({
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [base(), noPrice],
      });

      const err: any = await r.completed().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "ADDON_CHECKOUT_ITEM_UNREADABLE" });
      expect((await r.rows())[0]).toMatchObject({ stripeItemId: null });
      expect(Number((await r.rows())[0].priceSnapshot)).toBe(0);
      expect(r.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
      expect(await unusable(r.tenantId)).toHaveLength(0);
    });

    it("PERMANENT: a row with quantity 0 — its item is deleted Stripe-first (prorated), ONE platform notice, the webhook resolves, the other SKU is adopted", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 0 },
          { sku: "FORECASTING", quantity: 1 },
        ],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
          stripeItem("si_fc", { sku: "FORECASTING", cents: 1900, quantity: 1 }),
        ],
      });

      await expect(r.completed()).resolves.toBeUndefined();

      expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
      expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledWith("si_pack", {
        proration_behavior: "create_prorations",
      });
      expect(r.items.map((i) => i.id)).toEqual(["si_base", "si_fc"]);
      expect((await r.rows()).map((x) => [x.sku, x.stripeItemId, x.quantity])).toEqual([
        ["CUSTOMER_PACK_100", null, 0],
        ["FORECASTING", "si_fc", 1],
      ]);
      const told = await unusable(r.tenantId);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ entityType: "tenant", entityId: r.tenantId });
      expect(told[0].meta).toMatchObject({
        sku: "CUSTOMER_PACK_100",
        rowQuantity: 0,
        itemQuantity: 2,
        itemIds: ["si_pack"],
        subscriptionId: "sub_qa",
        message: expect.stringContaining("has no usable quantity (row 0, item 2)"),
      });
      expect((await r.ledger()).filter((e) => e.sku === "CUSTOMER_PACK_100")).toEqual([]);

      await r.completed(); // a redelivery: no second notice, nothing more deleted
      expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
      expect(await unusable(r.tenantId)).toHaveLength(1);
    });

    it("PERMANENT: a Stripe failure on the delete fails the webhook (retried) and writes no notice yet; the retry then cleans up and announces once", async () => {
      const r = await rig({
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 0 }],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });
      r.stripeClient.subscriptionItems.del.mockRejectedValueOnce(
        new Error("Stripe API error (500)"),
      );

      await expect(r.completed()).rejects.toThrow(/Stripe API error/);
      expect(r.items.map((i) => i.id)).toContain("si_pack");
      expect(await unusable(r.tenantId)).toHaveLength(0);

      await expect(r.completed()).resolves.toBeUndefined();
      expect(r.items.map((i) => i.id)).toEqual(["si_base"]);
      expect(await unusable(r.tenantId)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // SHOULD-1 — a SKU the checkout LISTED whose item is not recognised throws + alerts, never a 2nd item.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("SHOULD-1: a listed SKU with no recognised item fails the webhook, alerts once, and never creates a second item (real Postgres)", () => {
    const listed = (r: Rig, skus: string) => ({
      metadata: { tenantId: r.tenantId, planKey: "STARTER", interval: "month", addonSkus: skus },
    });
    /** An item whose product came back as a bare id (not expanded): its add-on tag is unreadable. */
    const unexpanded = (id: string, sku: string, cents: number, quantity: number) => {
      const i: any = stripeItem(id, { sku, cents, quantity });
      i.price = { ...i.price, product: `prod_${id}` };
      return i;
    };
    const alerts = (tenantId: string) =>
      prisma.auditLog.findMany({
        where: { tenantId, action: "ADDON_CHECKOUT_ITEMS_UNRECOGNISED" },
      });

    it.each([false, true])(
      "(flag on=%s) unrecognised listed items: coded 409, NO create/delete, rows untouched, ONE alert however often it is redelivered",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [
            { sku: "CUSTOMER_PACK_100", quantity: 2 },
            { sku: "FORECASTING", quantity: 1 },
          ],
          items: [
            base(),
            unexpanded("si_pack", "CUSTOMER_PACK_100", 5000, 2),
            unexpanded("si_fc", "FORECASTING", 1900, 1),
          ],
        });
        const session = listed(r, "CUSTOMER_PACK_100,FORECASTING");

        for (let n = 0; n < 3; n += 1) {
          const err: any = await r.deliver(session).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(ConflictException);
          expect(err.getResponse()).toMatchObject({ code: "ADDON_CHECKOUT_ITEM_MISSING" });
        }

        for (const fn of ["create", "update", "del"] as const) {
          expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
        }
        expect(r.items.map((i: any) => i.id)).toEqual(["si_base", "si_pack", "si_fc"]); // all still there
        expect((await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)])).toEqual([
          [null, 0],
          [null, 0],
        ]);
        const told = await alerts(r.tenantId);
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({ entityType: "tenant", entityId: r.tenantId });
        expect(told[0].meta).toMatchObject({
          skus: ["CUSTOMER_PACK_100", "FORECASTING"],
          subscriptionId: "sub_qa",
          checkoutSessionId: r.sessionId,
          message: expect.stringContaining("no second item was created"),
        });
      },
    );

    it("a recognised listed SKU is still adopted (no stranding); only the unrecognised one fails the webhook", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 2 },
          { sku: "FORECASTING", quantity: 1 },
        ],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
          unexpanded("si_fc", "FORECASTING", 1900, 1),
        ],
      });

      await expect(r.deliver(listed(r, "CUSTOMER_PACK_100,FORECASTING"))).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect((await r.rows()).map((x) => [x.sku, x.stripeItemId])).toEqual([
        ["CUSTOMER_PACK_100", "si_pack"],
        ["FORECASTING", null],
      ]);
      expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
      expect((await alerts(r.tenantId))[0].meta).toMatchObject({ skus: ["FORECASTING"] });
    });

    it.each([false, true])(
      "S1 (flag on=%s): a legitimate deletion then redeliveries — the first delivery deletes the switched-off row's item, the redeliveries resolve with NO alert (no 409 loop)",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2, active: false }],
          items: [
            base(),
            stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
          ],
        });
        const session = listed(r, "CUSTOMER_PACK_100");

        await r.deliver(session);
        expect(r.items.map((i: any) => i.id)).toEqual(["si_base"]);
        await r.deliver(session);
        await r.deliver(session);

        expect(await alerts(r.tenantId)).toHaveLength(0);
        expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
        expect(r.stripeClient.subscriptionItems.del).toHaveBeenCalledTimes(1);
      },
    );

    it("S1: listed SKUs with a quantity-0 row, or only a comp row, and no item: resolves, no alert", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 0 },
          { sku: "FORECASTING", quantity: 1, isComp: true },
        ],
        items: [base()],
      });

      await expect(r.deliver(listed(r, "CUSTOMER_PACK_100,FORECASTING"))).resolves.toBeUndefined();

      expect(await alerts(r.tenantId)).toHaveLength(0);
      expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
    });

    it("control: an add-on enabled AFTER the session (not listed) still goes through path (c), no alert", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 2 },
          { sku: "FORECASTING", quantity: 1 },
        ],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });

      await r.deliver(listed(r, "CUSTOMER_PACK_100"));

      expect(r.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect((await r.rows()).map((x) => !!x.stripeItemId)).toEqual([true, true]);
      expect(await alerts(r.tenantId)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // SHOULD-2 — the crossing sums count only BILLABLE add-ons.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("SHOULD-2: a comp with a stale snapshot is never booked at a crossing (real Postgres)", () => {
    it("checkout completion: the activation crossing books the base only; the comp's lingering 19 is not revenue", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 2 },
          { sku: "FORECASTING", quantity: 1, isComp: true, priceSnapshot: 19 }, // billed once, then comped
        ],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });

      await r.completed();

      expect(await r.ledger()).toEqual([
        { type: BILLING_EVENTS.SUBSCRIPTION_RESUMED, delta: 99, sku: undefined },
        { type: BILLING_EVENTS.ADDON_ENABLED, delta: 100, sku: "CUSTOMER_PACK_100" },
      ]);
      expect(await r.ledgerSum()).toBe(199);
    });

    it("subscribe(): a trial's plan pick books the billable kept row and not the comp's stale snapshot", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 2, priceSnapshot: 12 },
          { sku: "FORECASTING", quantity: 1, isComp: true, priceSnapshot: 19 },
        ],
        items: [base()],
      });

      await r.mutations.subscribe(r.tenantId, { planKey: "STARTER", cycle: "MONTHLY" }, "admin-1");

      const adds = (await r.ledger()).filter((e) => e.type === BILLING_EVENTS.ADDON_ENABLED);
      expect(adds).toEqual([
        { type: BILLING_EVENTS.ADDON_ENABLED, delta: 24, sku: "CUSTOMER_PACK_100" },
      ]);
      expect(await r.ledgerSum()).toBe(99 + 24); // never + 19
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // SHOULD-3 — a PAID completion refused for no stored customer / no subscription row raises a notice.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("SHOULD-3: a paid completion with no customer on file / no subscription row is refused AND announced once (real Postgres)", () => {
    const paidNotices = (tenantId: string) =>
      prisma.auditLog.findMany({
        where: { tenantId, action: "STRIPE_PAID_CHECKOUT_NOT_APPLIED" },
      });
    const trail = (r: Rig) =>
      prisma.auditLog.findMany({
        where: {
          entityType: "stripe_checkout_session",
          entityId: r.sessionId,
          action: "STRIPE_CHECKOUT_REFUSED",
        },
      });
    const paidRig = () =>
      rig({
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });

    it("no customer on file: nothing applied, ONE trail row, ONE notice (however often it is redelivered)", async () => {
      const r = await paidRig();
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { stripeCustomerId: null },
      });

      await r.deliver({ payment_status: "paid" });
      await r.deliver({ payment_status: "paid" });
      await r.deliver({ payment_status: "paid" });

      expect(await tenantStatusOf(r.tenantId)).toBe(TenantStatus.TRIAL);
      expect((await r.rows())[0]).toMatchObject({ stripeItemId: null });
      expect(await r.ledger()).toEqual([]);
      expect(await trail(r)).toHaveLength(1);
      const told = await paidNotices(r.tenantId);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ entityType: "tenant", entityId: r.tenantId });
      expect(told[0].meta).toMatchObject({
        reason: "customer_not_on_file",
        subscriptionId: "sub_qa",
        subscriptionStatus: "active",
        chargedButNotRecorded: true,
        checkoutSessionId: r.sessionId,
        message: expect.stringContaining("was NOT applied: no Stripe customer is on file"),
      });
    });

    it("no subscription row at all: the same refusal and notice", async () => {
      const r = await paidRig();
      await prisma.tenantSubscription.delete({ where: { tenantId: r.tenantId } });

      await r.deliver({ payment_status: "paid" });

      expect(await paidNotices(r.tenantId)).toHaveLength(1);
      expect(await trail(r)).toHaveLength(1);
      expect(await r.ledger()).toEqual([]);
    });

    it("not charged (an incomplete subscription, an unpaid session): the trail row only", async () => {
      const r = await paidRig();
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { stripeCustomerId: null },
      });
      r.subs.sub_qa.status = "incomplete";

      await r.deliver({ payment_status: "unpaid" });

      expect(await trail(r)).toHaveLength(1);
      expect(await paidNotices(r.tenantId)).toHaveLength(0);
    });

    it("a customer MISMATCH keeps the trail only (unchanged)", async () => {
      const r = await rig({
        sessionCustomer: "cus_attacker",
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [base()],
      });
      await r.deliver({ payment_status: "paid" });
      expect(await trail(r)).toHaveLength(1);
      expect(await paidNotices(r.tenantId)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // S2 fold — with no live subscription at checkout, a pointer that is not on the CURRENT subscription is stale.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("S2 fold: a stripeItemId that is not on the current subscription is stale (real Postgres)", () => {
    it("checkout lines: a row pointing at a dead subscription's item is billed on the new checkout (one line per SKU); an annual checkout is refused", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 2, stripeItemId: "si_dead", priceSnapshot: 40 },
          { sku: "FORECASTING", quantity: 1 },
        ],
        items: [base()],
      });

      const lines = await r.mutations.checkoutAddonLines(r.tenantId, "month");

      expect(lines.skus).toEqual(["CUSTOMER_PACK_100", "FORECASTING"]);
      expect(lines.lineItems.map((l: any) => l.quantity)).toEqual([2, 1]);
      await expect(r.mutations.checkoutAddonLines(r.tenantId, "year")).rejects.toMatchObject({
        response: {
          code: "ADDON_ANNUAL_NOT_SUPPORTED",
          // the refusal names the add-ons to switch off
          message: expect.stringContaining("Switch off Customer pack (+100), Forecasting"),
        },
      });
    });

    it("NIT3: the same quantity-0 row raises ONE quantity-missing notice, however many checkouts are created", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 0 },
          { sku: "FORECASTING", quantity: 1 },
        ],
        items: [base()],
      });

      await r.mutations.checkoutAddonLines(r.tenantId, "month");
      await r.mutations.checkoutAddonLines(r.tenantId, "month");
      await r.mutations.checkoutAddonLines(r.tenantId, "month");

      const told = await prisma.auditLog.findMany({
        where: { tenantId: r.tenantId, action: "ADDON_CHECKOUT_ITEM_UNUSABLE" },
      });
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ entityType: "tenant", entityId: r.tenantId });
      expect(told[0].meta).toMatchObject({
        reason: "quantity_missing",
        sku: "CUSTOMER_PACK_100",
        rowQuantity: 0,
        message: expect.stringContaining("quantity missing (row 0)"),
      });
    });

    it("NIT1: a quantity-0 row gets no checkout line (no charge-then-credit) and never refuses an annual checkout", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 0 },
          { sku: "FORECASTING", quantity: 1 },
        ],
        items: [base()],
      });

      const lines = await r.mutations.checkoutAddonLines(r.tenantId, "month");
      expect(lines.skus).toEqual(["FORECASTING"]);
      expect(lines.lineItems.map((l: any) => l.quantity)).toEqual([1]);

      await prisma.tenantAddon.updateMany({
        where: { tenantId: r.tenantId, sku: "FORECASTING" },
        data: { active: false },
      });
      await expect(r.mutations.checkoutAddonLines(r.tenantId, "year")).resolves.toEqual({
        lineItems: [],
        skus: [],
      });
    });

    it.each([false, true])(
      "(flag on=%s) the dead pointer is replaced by the checkout's new item (adopted, never deleted); stored -> actual is booked once",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [
            { sku: "CUSTOMER_PACK_100", quantity: 2, stripeItemId: "si_dead", priceSnapshot: 40 },
          ],
          items: [
            base(),
            stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
          ],
        });

        await r.completed();
        await r.completed(); // and its redelivery

        expect((await r.rows())[0]).toMatchObject({ stripeItemId: "si_pack", quantity: 2 });
        expect(Number((await r.rows())[0].priceSnapshot)).toBe(50);
        expect(r.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
        expect(r.items.map((i: any) => i.id)).toEqual(["si_base", "si_pack"]);
        // the crossing priced the STORED 40 x 2, adoption nets it to 50 x 2: the base + 100, each once
        expect(await r.ledgerSum()).toBe(99 + 100);
        expect((await r.ledger()).filter((e) => e.sku === "CUSTOMER_PACK_100")).toEqual([
          { type: BILLING_EVENTS.ADDON_ENABLED, delta: 20, sku: "CUSTOMER_PACK_100" },
        ]);
      },
    );

    it("the pointer is swapped by compare-and-swap ON THAT VALUE: re-pointed by another writer meanwhile -> nothing adopted, the webhook fails", async () => {
      const r = await rig({
        rows: [
          { sku: "CUSTOMER_PACK_100", quantity: 3, stripeItemId: "si_dead", priceSnapshot: 40 },
        ],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });
      r.stripeClient.subscriptionItems.update.mockImplementationOnce(
        async (id: string, args: any) => {
          await prisma.tenantAddon.updateMany({
            where: { tenantId: r.tenantId },
            data: { stripeItemId: "si_other" },
          });
          const i = r.items.find((x: any) => x.id === id);
          if (i) i.quantity = args.quantity;
          return { id };
        },
      );

      await expect(r.completed()).rejects.toBeInstanceOf(ConflictException);

      expect((await r.rows())[0].stripeItemId).toBe("si_other");
      expect((await r.ledger()).filter((e) => e.sku === "CUSTOMER_PACK_100")).toEqual([]);
    });

    it("a stale pointer and NO checkout item: path (c) creates ONE item on the new subscription and swaps the pointer", async () => {
      const r = await rig({
        rows: [{ sku: "FORECASTING", quantity: 1, stripeItemId: "si_dead", priceSnapshot: 19 }],
        items: [base()],
      });

      await r.completed();

      expect(r.stripeClient.subscriptionItems.create).toHaveBeenCalledTimes(1);
      const row = (await r.rows())[0];
      expect(row.stripeItemId).toBeTruthy();
      expect(row.stripeItemId).not.toBe("si_dead");
      expect(r.items.filter((i: any) => i.metadata?.sku === "FORECASTING")).toHaveLength(1);
    });

    it("a pointer that IS on the current subscription (an in-app enable item) and no checkout item: untouched", async () => {
      const inApp: any = stripeItem("si_inapp", { cents: 1900, quantity: 1 });
      const r = await rig({
        rows: [{ sku: "FORECASTING", quantity: 1, stripeItemId: "si_inapp", priceSnapshot: 19 }],
        items: [base(), inApp],
      });
      inApp.metadata = { tenantId: r.tenantId, sku: "FORECASTING" };

      await r.completed();

      expect(r.stripeClient.subscriptionItems.create).not.toHaveBeenCalled();
      expect(r.stripeClient.subscriptionItems.del).not.toHaveBeenCalled();
      expect((await r.rows())[0].stripeItemId).toBe("si_inapp");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // MUST-A2 — only resource_missing means "stored subscription not live"; any other Stripe error fails CLOSED.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("MUST-A2: a transient Stripe error while judging a duplicate throws with nothing written (real Postgres)", () => {
    const decisionRows = (tenantId: string) =>
      prisma.auditLog.findMany({
        where: {
          tenantId,
          action: { in: ["STRIPE_CHECKOUT_DUPLICATE", "STRIPE_DUPLICATE_CHECKOUT"] },
        },
      });
    const failStoredLookup = (r: Rig, error: any) => {
      const real = r.stripe.getSubscription.getMockImplementation()!;
      r.stripe.getSubscription.mockImplementation(async (id: string, p?: unknown) => {
        if (id === "sub_old") throw error;
        return real(id, p);
      });
      return () => r.stripe.getSubscription.mockImplementation(real);
    };

    it.each([false, true])(
      "(flag on=%s) a transient error reading the stored subscription: the webhook throws; the stored sub is unchanged, no adoption, no MRR, no notice, no cancel; the redelivery is then judged a duplicate",
      async (flagOn) => {
        const r = await rig({
          flagOn,
          rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
          items: [
            base(),
            stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
          ],
        });
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: { stripeSubId: "sub_old" },
        });
        r.addSub("sub_old", { items: [], latestInvoice: null });
        const heal = failStoredLookup(
          r,
          Object.assign(new Error("An error occurred with our connection to Stripe."), {
            type: "StripeConnectionError",
          }),
        );

        await expect(r.completed()).rejects.toMatchObject({ type: "StripeConnectionError" });

        const sub = await prisma.tenantSubscription.findUniqueOrThrow({
          where: { tenantId: r.tenantId },
        });
        expect(sub.stripeSubId).toBe("sub_old"); // never overwritten
        expect((await prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId } })).status).toBe(
          TenantStatus.TRIAL,
        );
        expect((await r.rows()).map((x) => [x.stripeItemId, Number(x.priceSnapshot)])).toEqual([
          [null, 0],
        ]);
        expect(await r.ledger()).toEqual([]);
        expect(await decisionRows(r.tenantId)).toHaveLength(0);
        for (const fn of ["create", "update", "del"] as const) {
          expect(r.stripeClient.subscriptionItems[fn]).not.toHaveBeenCalled();
        }
        expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();

        heal(); // Stripe answers again: sub_old is active, so this session is the duplicate
        await r.completed();

        expect(
          (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: r.tenantId } }))
            .stripeSubId,
        ).toBe("sub_old");
        expect(r.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
        expect(await decisionRows(r.tenantId)).toHaveLength(2); // the decision row + the one notice
        expect(await r.ledger()).toEqual([]);
      },
    );

    it("resource_missing from Stripe still means 'stale': the stored id is replaced and the checkout completes", async () => {
      const r = await rig({
        rows: [{ sku: "CUSTOMER_PACK_100", quantity: 2 }],
        items: [
          base(),
          stripeItem("si_pack", { sku: "CUSTOMER_PACK_100", cents: 5000, quantity: 2 }),
        ],
      });
      await prisma.tenantSubscription.update({
        where: { tenantId: r.tenantId },
        data: { stripeSubId: "sub_old" },
      });
      failStoredLookup(
        r,
        Object.assign(new Error("No such subscription"), { code: "resource_missing" }),
      );

      await r.completed();

      expect(
        (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: r.tenantId } }))
          .stripeSubId,
      ).toBe("sub_qa");
      expect(r.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(await decisionRows(r.tenantId)).toHaveLength(0);
    });
  });
});
