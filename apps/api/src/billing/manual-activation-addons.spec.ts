/**
 * SA-668c residual ("price them + notify"): a MANUAL activation that crosses a tenant from TRIAL to ACTIVE
 * prices its unbilled self-serve add-ons at today's catalog price, books each delta once and writes one
 * ADDON_MANUAL_INVOICE_DUE notice each (see manual-activation-addons.ts). Any other prior status (a renewal)
 * prices nothing. Idempotent; comps and Stripe-billed rows are never touched. The real-Postgres cases are in
 * common/override-activation-ledger.db.spec.ts.
 */
const lockCalls: Array<{ family: string; keys: string[] }> = [];
let lockBehaviour: "ok" | "timeout" = "ok";
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLocks: async (
    opts: { family: string; keys: string[] },
    fn: () => Promise<unknown>,
  ) => {
    if (lockBehaviour === "timeout") throw new MockLockTimeoutError("lock_timeout");
    lockCalls.push({ family: opts.family, keys: [...new Set(opts.keys)].sort() });
    return fn();
  },
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { ServiceUnavailableException } from "@nestjs/common";
import {
  priceUnbilledAddonsOnActivation,
  unbilledSelfServeSkus,
  withAddonLocks,
} from "./manual-activation-addons";
import { BILLING_EVENTS } from "./plan-catalog.constants";

const CATALOG = [
  { sku: "CUSTOMER_PACK_100", name: "Customer pack (+100)", monthlyPrice: "50.00" },
  { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19, includedAtPlan: "SCALE" },
  { sku: "MSRP", name: "MSRP", monthlyPrice: 20 },
];

let seq = 0;
const row = (sku: string, o: Record<string, unknown> = {}) => ({
  id: `a${++seq}`,
  tenantId: "t1",
  addonKey: sku,
  sku,
  quantity: 1,
  active: true,
  priceSnapshot: 0,
  stripeItemId: null as string | null,
  createdAt: new Date(1_790_000_000_000 + seq),
  ...o,
});

/** The slice of a Prisma `where` these helpers use (equality keys + `isComp`), evaluated on in-memory rows. */
const matchesWhere = (r: any, where: any): boolean =>
  r.tenantId === where.tenantId &&
  r.active === where.active &&
  r.stripeItemId === where.stripeItemId &&
  (where.isComp === undefined || (r.isComp ?? false) === where.isComp);

function make(
  rows: any[],
  opts: { casLost?: boolean; tenantClass?: string; notices?: any[] } = {},
) {
  const notices: any[] = opts.notices ?? [];
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const tx: any = {
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matchesWhere(r, where))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (opts.casLost) return { count: 0 };
        // the writer limits its updateMany to the rows it locked: AND: [guard, { id: { in } }]
        const guard = where.AND ? where.AND[0] : where;
        const r = rows.find((x) => x.id === guard.id);
        if (
          !r ||
          !r.active ||
          r.stripeItemId !== null ||
          (guard.isComp === false && r.isComp) ||
          Number(r.priceSnapshot ?? 0) !== 0
        ) {
          return { count: 0 };
        }
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
    // the platform notices written so far (the idempotency check reads them back, newest first)
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        notices.push({ ...data, createdAt: notices.length });
        return {};
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const hits = notices
          .filter(
            (n) =>
              n.tenantId === where.tenantId &&
              where.action.in.includes(n.action) &&
              n.meta?.sku === where.meta.equals,
          )
          .sort((x, y) => y.createdAt - x.createdAt);
        return hits[0] ? { action: hits[0].action } : null;
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: opts.tenantClass ?? "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "STARTER" },
      }),
    },
  };
  const price = (
    planKey = "STARTER",
    over: Partial<Parameters<typeof priceUnbilledAddonsOnActivation>[2]> = {},
  ) =>
    priceUnbilledAddonsOnActivation(tx, events, {
      tenantId: "t1",
      tenantLabel: "Acme Foods",
      fromStatus: "TRIAL",
      tenantClass: opts.tenantClass ?? "PRODUCTION",
      planKey,
      catalogAddons: CATALOG,
      actorId: "admin-1",
      ...over,
    });
  const ledger = () =>
    events.emit.mock.calls.map((c: any[]) => ({
      type: c[1],
      sku: c[2]?.sku,
      delta: c[3]?.amountDelta,
    }));
  const noticeMeta = () => tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
  return { rows, tx, events, price, ledger, noticeMeta };
}

beforeEach(() => {
  lockCalls.length = 0;
  lockBehaviour = "ok";
});

describe("priceUnbilledAddonsOnActivation", () => {
  it("trial + 2 unbilled rows (+1 comp): prices the 2 at TODAY's catalog price, +delta once each, 2 DUE notices, the comp untouched", async () => {
    const h = make([
      row("CUSTOMER_PACK_100", { quantity: 2 }),
      row("FORECASTING", { quantity: 1 }),
      row("MSRP", { quantity: 1, isComp: true }), // admin-granted comp: never billed (and not self-serve)
      row("CUSTOMER_PACK_100", { addonKey: "extra", quantity: 1, isComp: true }),
    ]);

    const priced = await h.price();

    expect(priced).toEqual([
      { sku: "CUSTOMER_PACK_100", quantity: 2, monthlyPrice: 50, priced: true, noticed: true },
      { sku: "FORECASTING", quantity: 1, monthlyPrice: 19, priced: true, noticed: true },
    ]);
    expect(h.rows.map((r) => [r.sku, Number(r.priceSnapshot), r.isComp ?? false])).toEqual([
      ["CUSTOMER_PACK_100", 50, false],
      ["FORECASTING", 19, false],
      ["MSRP", 0, true],
      ["CUSTOMER_PACK_100", 0, true],
    ]);
    // {0, qty} → {price, qty}, once per row: 100 and 19
    expect(h.ledger()).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, sku: "CUSTOMER_PACK_100", delta: 100 },
      { type: BILLING_EVENTS.ADDON_ENABLED, sku: "FORECASTING", delta: 19 },
    ]);
    // the notice is the MANUAL enable path's: kind "add", name and quantity, in the platform feed
    expect(h.noticeMeta()).toEqual([
      expect.objectContaining({
        tenantId: "t1",
        userId: "admin-1",
        action: "ADDON_MANUAL_INVOICE_DUE",
        entityType: "tenant",
        entityId: "t1",
        meta: {
          platformAdmin: true,
          sku: "CUSTOMER_PACK_100",
          quantity: 2,
          monthlyPrice: 50,
          message:
            "Add-on Customer pack (+100) enabled for Acme Foods: add to their next manual invoice",
          addonName: "Customer pack (+100)",
          kind: "add",
          fromQty: 0,
          toQty: 2,
        },
      }),
      expect.objectContaining({
        action: "ADDON_MANUAL_INVOICE_DUE",
        meta: expect.objectContaining({
          sku: "FORECASTING",
          quantity: 1,
          monthlyPrice: 19,
          kind: "add",
        }),
      }),
    ]);
  });

  it("IDEMPOTENT: a re-activation (the rows are priced now) books nothing and writes no second notice", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);
    await h.price();
    const ledger = h.ledger();
    const notices = h.noticeMeta().length;

    const again = await h.price();

    // the row is still listed (it is unbilled), but nothing is priced or announced a second time
    expect(again.map((x) => [x.sku, x.priced, x.noticed])).toEqual([
      ["CUSTOMER_PACK_100", false, false],
    ]);
    expect(h.ledger()).toEqual(ledger);
    expect(h.noticeMeta()).toHaveLength(notices);
  });

  it("a Stripe-billed row and a switched-off row are untouched", async () => {
    const h = make([
      row("CUSTOMER_PACK_100", { quantity: 3, stripeItemId: "si_billed", priceSnapshot: 11 }),
      row("CUSTOMER_PACK_100", { addonKey: "other", active: false }), // switched off
    ]);
    expect(await h.price()).toEqual([]);
    expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
    expect(h.ledger()).toEqual([]);
    expect(h.noticeMeta()).toEqual([]);
    expect(h.rows.map((r) => Number(r.priceSnapshot))).toEqual([11, 0]);
  });

  it("S3: a row that ALREADY carries a price but no Stripe item is announced (DUE) without being priced or booked again", async () => {
    const h = make([row("FORECASTING", { quantity: 2, priceSnapshot: 19 })]);

    const out = await h.price();

    expect(out).toEqual([
      { sku: "FORECASTING", quantity: 2, monthlyPrice: 19, priced: false, noticed: true },
    ]);
    expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled(); // no pricing write
    expect(h.ledger()).toEqual([]); // no second MRR booking
    expect(h.noticeMeta()).toHaveLength(1);
    expect(h.noticeMeta()[0]).toMatchObject({
      action: "ADDON_MANUAL_INVOICE_DUE",
      meta: expect.objectContaining({
        sku: "FORECASTING",
        quantity: 2,
        monthlyPrice: 19,
        kind: "add",
      }),
    });
  });

  it("S3: the notice is idempotent — skipped when the LATEST manual notice for the SKU is already a DUE, written again after a STOP", async () => {
    const due = (sku: string, n: number) => ({
      tenantId: "t1",
      action: "ADDON_MANUAL_INVOICE_DUE",
      meta: { sku },
      createdAt: n,
    });
    const stop = (sku: string, n: number) => ({
      tenantId: "t1",
      action: "ADDON_MANUAL_INVOICE_STOP",
      meta: { sku },
      createdAt: n,
    });
    const h = make(
      [
        row("FORECASTING", { priceSnapshot: 19 }), // a DUE already stands
        row("CUSTOMER_PACK_100", { priceSnapshot: 50 }), // DUE, then STOP: it must be announced again
      ],
      {
        notices: [due("FORECASTING", 1), due("CUSTOMER_PACK_100", 2), stop("CUSTOMER_PACK_100", 3)],
      },
    );

    const out = await h.price();

    expect(out.map((x) => [x.sku, x.noticed])).toEqual([
      ["FORECASTING", false],
      ["CUSTOMER_PACK_100", true],
    ]);
    expect(h.noticeMeta()).toHaveLength(1);
    expect(h.noticeMeta()[0].meta.sku).toBe("CUSTOMER_PACK_100");
  });

  it("S3: a comp and a bundled SKU are never announced, and the notice is read only for notices of that SKU in the platform feed", async () => {
    const h = make([
      row("FORECASTING", { priceSnapshot: 19, isComp: true }),
      row("FORECASTING", { addonKey: "f2", priceSnapshot: 19 }),
    ]);
    expect((await h.price("SCALE")).length).toBe(0); // FORECASTING is bundled at SCALE: not billed, not announced
    expect(h.noticeMeta()).toEqual([]);
    const h2 = make([row("FORECASTING", { priceSnapshot: 19 })]);
    await h2.price();
    expect(h2.tx.auditLog.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: "t1",
      entityType: "tenant",
      meta: { path: ["sku"], equals: "FORECASTING" },
    });
  });

  it("a comp is never priced, never booked and never announced — even a self-serve SKU", async () => {
    const h = make([row("FORECASTING", { quantity: 1, isComp: true })]);
    expect(await h.price()).toEqual([]);
    expect(h.ledger()).toEqual([]);
    expect(h.noticeMeta()).toEqual([]);
    // the comp is excluded by the QUERY (billableAddonWhere), not by a per-site check
    expect(h.tx.tenantAddon.findMany.mock.calls[0][0].where).toMatchObject({ isComp: false });
    expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
  });

  it("a SKU the plan already bundles is never sold again: not priced, not announced", async () => {
    const h = make([row("FORECASTING"), row("CUSTOMER_PACK_100")]);
    const priced = await h.price("SCALE"); // FORECASTING is bundled at SCALE (F3)
    expect(priced.map((p) => p.sku)).toEqual(["CUSTOMER_PACK_100"]);
    expect(h.noticeMeta().map((n: any) => n.meta.sku)).toEqual(["CUSTOMER_PACK_100"]);
  });

  it("the row write is a compare-and-swap: a lost race books nothing and writes no notice", async () => {
    const h = make([row("CUSTOMER_PACK_100")], { casLost: true });
    expect(await h.price()).toEqual([]);
    expect(h.ledger()).toEqual([]);
    expect(h.noticeMeta()).toEqual([]);
  });

  it("NIT: the compare-and-swap is scoped to the tenant as well as the row id, and is still unbilled/non-comp/unpriced", async () => {
    const h = make([row("CUSTOMER_PACK_100")]);
    await h.price();
    expect(h.tx.tenantAddon.updateMany.mock.calls[0][0].where).toEqual({
      AND: [
        {
          id: h.rows[0].id,
          tenantId: "t1",
          active: true,
          stripeItemId: null,
          isComp: false,
          OR: [{ priceSnapshot: null }, { priceSnapshot: 0 }],
        },
        { id: { in: [h.rows[0].id] } }, // limited to the rows the writer locked and recorded
      ],
    });
  });

  it("money is rounded to cents", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 1 })]);
    const out = await h.price("STARTER", {
      catalogAddons: [{ sku: "CUSTOMER_PACK_100", name: "Pack", monthlyPrice: "49.999" }],
    });
    expect(out).toEqual([
      { sku: "CUSTOMER_PACK_100", quantity: 1, monthlyPrice: 50, priced: true, noticed: true },
    ]);
    expect(Number(h.rows[0].priceSnapshot)).toBe(50);
  });
});

describe("M-A: pricing happens on the TRIAL → ACTIVE crossing ONLY", () => {
  it.each(["ACTIVE", "READ_ONLY", "SUSPENDED", "CANCELLED", "PAST_DUE"])(
    "an activation of a %s tenant (a renewal) prices NOTHING: no row read, no price, no MRR, no notice — even for a $0 item-less add-on",
    async (status) => {
      const h = make([
        row("CUSTOMER_PACK_100", { quantity: 2 }),
        row("FORECASTING", { priceSnapshot: 19 }),
      ]);

      const out = await h.price("STARTER", { fromStatus: status });

      expect(out).toEqual([]);
      expect(h.tx.tenantAddon.findMany).not.toHaveBeenCalled();
      expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(h.ledger()).toEqual([]);
      expect(h.noticeMeta()).toEqual([]);
      expect(h.rows.map((r) => Number(r.priceSnapshot))).toEqual([0, 19]);
    },
  );

  it("TRIAL is the only crossing that prices (control)", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);
    const out = await h.price("STARTER", { fromStatus: "TRIAL" });
    expect(out.map((x) => [x.sku, x.priced, x.noticed])).toEqual([
      ["CUSTOMER_PACK_100", true, true],
    ]);
  });
});

describe("MUST-A1: a LAPSED trial (READ_ONLY + trial_expired / trial_cancelled) activated manually is priced like a trial", () => {
  it.each(["trial_expired", "trial_cancelled"])(
    "READ_ONLY + %s: priced at today's catalog price, MRR booked once, a DUE notice raised",
    async (readOnlyReason) => {
      const h = make([
        row("CUSTOMER_PACK_100", { quantity: 2 }),
        row("FORECASTING", { quantity: 1 }),
      ]);

      const out = await h.price("STARTER", { fromStatus: "READ_ONLY", readOnlyReason });

      expect(out.map((x) => [x.sku, x.priced, x.noticed])).toEqual([
        ["CUSTOMER_PACK_100", true, true],
        ["FORECASTING", true, true],
      ]);
      expect(h.ledger()).toEqual([
        { type: BILLING_EVENTS.ADDON_ENABLED, sku: "CUSTOMER_PACK_100", delta: 100 },
        { type: BILLING_EVENTS.ADDON_ENABLED, sku: "FORECASTING", delta: 19 },
      ]);
      expect(h.noticeMeta().map((n: any) => [n.action, n.meta.sku])).toEqual([
        ["ADDON_MANUAL_INVOICE_DUE", "CUSTOMER_PACK_100"],
        ["ADDON_MANUAL_INVOICE_DUE", "FORECASTING"],
      ]);
      expect(h.rows.map((r) => Number(r.priceSnapshot))).toEqual([50, 19]);
    },
  );

  it.each([["subscription_cancelled"], [null], [undefined], ["something_else"]])(
    "READ_ONLY with reason %p (a cancelled PAID subscription, or none) is NOT a lapsed trial: prices nothing",
    async (readOnlyReason) => {
      const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);

      const out = await h.price("STARTER", { fromStatus: "READ_ONLY", readOnlyReason });

      expect(out).toEqual([]);
      expect(h.tx.tenantAddon.findMany).not.toHaveBeenCalled();
      expect(h.ledger()).toEqual([]);
      expect(h.noticeMeta()).toEqual([]);
    },
  );

  it("a trial_expired reason on a tenant that is NOT READ_ONLY (a stale reason on an ACTIVE tenant) prices nothing", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);
    expect(
      await h.price("STARTER", { fromStatus: "ACTIVE", readOnlyReason: "trial_expired" }),
    ).toEqual([]);
    expect(h.ledger()).toEqual([]);
  });
});

describe("M-A: rows that cannot be priced are announced, never silently priced or skipped", () => {
  it("a SKU the catalog does not price: no price, no MRR, a DUE notice saying 'price unknown — set it before invoicing'", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);

    const out = await h.price("STARTER", {
      catalogAddons: [{ sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19 }], // no CUSTOMER_PACK_100
    });

    expect(out).toEqual([
      {
        sku: "CUSTOMER_PACK_100",
        quantity: 2,
        monthlyPrice: 0,
        priced: false,
        noticed: true,
        reason: "price_unknown",
      },
    ]);
    expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
    expect(h.ledger()).toEqual([]);
    expect(h.rows.map((r) => Number(r.priceSnapshot))).toEqual([0]);
    expect(h.noticeMeta()).toHaveLength(1);
    expect(h.noticeMeta()[0].meta).toMatchObject({
      sku: "CUSTOMER_PACK_100",
      reason: "price_unknown",
      message:
        "Add-on CUSTOMER_PACK_100 enabled for Acme Foods: price unknown — set it before invoicing",
    });
  });

  it.each([0, -5, "free", null])(
    "a catalog price of %p (zero, negative or unreadable) is not priced either — same notice",
    async (monthlyPrice) => {
      const h = make([row("CUSTOMER_PACK_100", { quantity: 1 })]);
      const out = await h.price("STARTER", {
        catalogAddons: [{ sku: "CUSTOMER_PACK_100", name: "Pack", monthlyPrice }],
      });
      expect(out.map((x) => [x.priced, x.noticed, x.reason])).toEqual([
        [false, true, "price_unknown"],
      ]);
      expect(h.ledger()).toEqual([]);
      expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(h.noticeMeta()[0].meta.message).toBe(
        "Add-on Pack enabled for Acme Foods: price unknown — set it before invoicing",
      );
    },
  );

  it.each([0, -1, null, "x"])(
    "a quantity of %p (below 1): never priced as 1 — no write, no MRR, a notice 'quantity missing — set it before invoicing'",
    async (quantity) => {
      const h = make([row("CUSTOMER_PACK_100", { quantity })]);

      const out = await h.price();

      expect(out).toEqual([
        {
          sku: "CUSTOMER_PACK_100",
          quantity: 0,
          monthlyPrice: 50, // what the catalog would charge once the quantity is set
          priced: false,
          noticed: true,
          reason: "quantity_missing",
        },
      ]);
      expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(h.ledger()).toEqual([]);
      expect(Number(h.rows[0].priceSnapshot)).toBe(0);
      expect(h.noticeMeta()[0].meta).toMatchObject({
        reason: "quantity_missing",
        quantity: 0,
        message:
          "Add-on Customer pack (+100) enabled for Acme Foods: quantity missing — set it before invoicing",
      });
    },
  );

  it("the 'cannot price' notice is idempotent too (a second activation attempt writes none)", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 0 })]);
    await h.price();
    const again = await h.price();
    expect(h.noticeMeta()).toHaveLength(1);
    expect(again.map((x) => x.noticed)).toEqual([false]);
  });
});

describe("M-A: ANNUAL tenants — the notice carries the cycle and the per-cycle amount; MRR stays monthly", () => {
  it("annual: notice has cycle ANNUAL and cycleAmount = annual price (10 months) × quantity; the ledger books the MONTHLY delta", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);

    const out = await h.price("STARTER", { cycle: "ANNUAL" });

    expect(out.map((x) => [x.priced, x.noticed, x.monthlyPrice])).toEqual([[true, true, 50]]);
    // MRR = monthly: 2 × $50 — never ×10 / ×12
    expect(h.ledger()).toEqual([
      { type: BILLING_EVENTS.ADDON_ENABLED, sku: "CUSTOMER_PACK_100", delta: 100 },
    ]);
    expect(Number(h.rows[0].priceSnapshot)).toBe(50);
    expect(h.noticeMeta()[0].meta).toMatchObject({
      monthlyPrice: 50,
      quantity: 2,
      cycle: "ANNUAL",
      cycleAmount: 1000, // annualPrice(50) = 500 per unit per year × 2
      message:
        "Add-on Customer pack (+100) enabled for Acme Foods: add $1000.00 per year to their next manual invoice (annual billing)",
    });
  });

  it("monthly: no cycle fields on the notice (its shape is unchanged)", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 2 })]);
    await h.price("STARTER", { cycle: "MONTHLY" });
    expect(h.noticeMeta()[0].meta).not.toHaveProperty("cycle");
    expect(h.noticeMeta()[0].meta).not.toHaveProperty("cycleAmount");
  });

  it("an already-priced row on an ANNUAL activation: notice with the annual amount, no second MRR", async () => {
    const h = make([row("FORECASTING", { quantity: 3, priceSnapshot: 19 })]);
    await h.price("STARTER", { cycle: "ANNUAL" });
    expect(h.ledger()).toEqual([]);
    expect(h.noticeMeta()[0].meta).toMatchObject({ cycle: "ANNUAL", cycleAmount: 570 }); // 190 × 3
  });
});

describe("M-A NIT: no DUE notice for a non-PRODUCTION tenant", () => {
  it.each(["TEST", "DEMO"])(
    "a %s-class tenant: no notice (and the ledger books nothing — it is never in the paying set)",
    async (tenantClass) => {
      const h = make(
        [row("CUSTOMER_PACK_100", { quantity: 2 }), row("FORECASTING", { priceSnapshot: 19 })],
        {
          tenantClass,
        },
      );
      await h.price();
      expect(h.noticeMeta()).toEqual([]);
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
      expect(h.ledger()).toEqual([]);
    },
  );
});

describe("unpricedSelfServeSkus + withAddonLocks", () => {
  const db = (rows: any[]) => ({
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matchesWhere(r, where))),
    },
  });

  it("lists the unbilled, non-comp, self-serve SKUs (priced or not — each may need its notice): sorted, once each", async () => {
    const skus = await unbilledSelfServeSkus(
      db([
        row("FORECASTING"),
        row("CUSTOMER_PACK_100"),
        row("CUSTOMER_PACK_100", { addonKey: "dupe" }),
        row("MSRP"), // not self-serve
        row("FORECASTING", { isComp: true }),
        row("CUSTOMER_PACK_100", { stripeItemId: "si_1" }),
        row("FORECASTING", { priceSnapshot: 19 }),
      ]),
      "t1",
    );
    expect(skus).toEqual(["CUSTOMER_PACK_100", "FORECASTING"]);
    expect(await unbilledSelfServeSkus(db([row("FORECASTING", { isComp: true })]), "t1")).toEqual(
      [],
    );
  });

  it("takes the shared addon:<tenant>:<sku> billing locks of every SKU TOGETHER on one connection (withAdvisoryLocks, sorted), then runs", async () => {
    const out = await withAddonLocks("t1", ["FORECASTING", "CUSTOMER_PACK_100"], async () => "ran");
    expect(out).toBe("ran");
    expect(lockCalls).toEqual([
      {
        family: "billing",
        keys: ["addon:t1:CUSTOMER_PACK_100", "addon:t1:FORECASTING"],
      },
    ]);
  });

  it("no SKU, no lock", async () => {
    expect(await withAddonLocks("t1", [], async () => 7)).toBe(7);
    expect(lockCalls).toEqual([]);
  });

  it("a lock that cannot be had is a 503 and fn never runs", async () => {
    lockBehaviour = "timeout";
    const fn = jest.fn();
    await expect(withAddonLocks("t1", ["FORECASTING"], fn)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
