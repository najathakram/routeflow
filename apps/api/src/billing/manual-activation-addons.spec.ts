/**
 * SA-668c residual ("price them + notify"): a MANUAL activation prices a trial's unbilled self-serve
 * add-ons at today's catalog price, books each delta once and writes one ADDON_MANUAL_INVOICE_DUE notice
 * each (see manual-activation-addons.ts). Idempotent; comps, Stripe-billed rows and priced rows are
 * never touched. The real-Postgres cases are in common/override-activation-ledger.db.spec.ts.
 */
const lockKeys: string[] = [];
let lockBehaviour: "ok" | "timeout" = "ok";
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (opts: { key: string }, fn: () => Promise<unknown>) => {
    if (lockBehaviour === "timeout") throw new MockLockTimeoutError("lock_timeout");
    lockKeys.push(opts.key);
    return { acquired: true, value: await fn() };
  },
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { ServiceUnavailableException } from "@nestjs/common";
import {
  priceUnbilledAddonsOnActivation,
  unpricedSelfServeSkus,
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

function make(rows: any[], opts: { casLost?: boolean; tenantStatus?: string } = {}) {
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const tx: any = {
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matchesWhere(r, where))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (opts.casLost) return { count: 0 };
        const r = rows.find((x) => x.id === where.id);
        if (
          !r ||
          !r.active ||
          r.stripeItemId !== null ||
          (where.isComp === false && r.isComp) ||
          Number(r.priceSnapshot ?? 0) !== 0
        ) {
          return { count: 0 };
        }
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: opts.tenantStatus ?? "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "STARTER" },
      }),
    },
  };
  const price = (planKey = "STARTER") =>
    priceUnbilledAddonsOnActivation(tx, events, {
      tenantId: "t1",
      tenantLabel: "Acme Foods",
      planKey,
      catalogAddons: CATALOG,
      actorId: "admin-1",
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
  lockKeys.length = 0;
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
      { sku: "CUSTOMER_PACK_100", quantity: 2, monthlyPrice: 50 },
      { sku: "FORECASTING", quantity: 1, monthlyPrice: 19 },
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

    expect(await h.price()).toEqual([]);

    expect(h.ledger()).toEqual(ledger);
    expect(h.noticeMeta()).toHaveLength(notices);
  });

  it("a Stripe-billed row and an already-priced row are untouched", async () => {
    const h = make([
      row("CUSTOMER_PACK_100", { quantity: 3, stripeItemId: "si_billed", priceSnapshot: 11 }),
      row("FORECASTING", { quantity: 1, priceSnapshot: 19 }), // already priced by an earlier activation
      row("CUSTOMER_PACK_100", { addonKey: "other", active: false }), // switched off
    ]);
    expect(await h.price()).toEqual([]);
    expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
    expect(h.ledger()).toEqual([]);
    expect(h.noticeMeta()).toEqual([]);
    expect(h.rows.map((r) => Number(r.priceSnapshot))).toEqual([11, 19, 0]);
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

  it("a SKU the plan already bundles, a SKU the catalog no longer prices and a free price are left alone", async () => {
    const h = make([row("FORECASTING"), row("CUSTOMER_PACK_100")]);
    // on SCALE, FORECASTING is bundled (F3): never sold again
    const priced = await h.price("SCALE");
    expect(priced.map((p) => p.sku)).toEqual(["CUSTOMER_PACK_100"]);

    const gone = make([row("CUSTOMER_PACK_100")]);
    const none = await priceUnbilledAddonsOnActivation(gone.tx, gone.events, {
      tenantId: "t1",
      tenantLabel: "Acme",
      planKey: "STARTER",
      catalogAddons: [{ sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19 }], // no CUSTOMER_PACK_100
    });
    expect(none).toEqual([]);

    const free = make([row("CUSTOMER_PACK_100")]);
    const zero = await priceUnbilledAddonsOnActivation(free.tx, free.events, {
      tenantId: "t1",
      tenantLabel: "Acme",
      planKey: "STARTER",
      catalogAddons: [{ sku: "CUSTOMER_PACK_100", name: "Pack", monthlyPrice: 0 }],
    });
    expect(zero).toEqual([]);
    expect(free.noticeMeta()).toEqual([]);
  });

  it("the row write is a compare-and-swap: a lost race books nothing and writes no notice", async () => {
    const h = make([row("CUSTOMER_PACK_100")], { casLost: true });
    expect(await h.price()).toEqual([]);
    expect(h.ledger()).toEqual([]);
    expect(h.noticeMeta()).toEqual([]);
  });

  it("money is rounded to cents and a quantity below 1 prices as 1", async () => {
    const h = make([row("CUSTOMER_PACK_100", { quantity: 0 })]);
    const out = await priceUnbilledAddonsOnActivation(h.tx, h.events, {
      tenantId: "t1",
      tenantLabel: "Acme",
      planKey: "STARTER",
      catalogAddons: [{ sku: "CUSTOMER_PACK_100", name: "Pack", monthlyPrice: "49.999" }],
    });
    expect(out).toEqual([{ sku: "CUSTOMER_PACK_100", quantity: 1, monthlyPrice: 50 }]);
    expect(Number(h.rows[0].priceSnapshot)).toBe(50);
  });
});

describe("unpricedSelfServeSkus + withAddonLocks", () => {
  const db = (rows: any[]) => ({
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matchesWhere(r, where))),
    },
  });

  it("lists only the unbilled, unpriced, non-comp, self-serve SKUs: sorted, once each", async () => {
    const skus = await unpricedSelfServeSkus(
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
    expect(await unpricedSelfServeSkus(db([row("FORECASTING", { isComp: true })]), "t1")).toEqual(
      [],
    );
  });

  it("takes the shared addon:<tenant>:<sku> billing lock of each SKU in order, then runs", async () => {
    const out = await withAddonLocks("t1", ["CUSTOMER_PACK_100", "FORECASTING"], async () => "ran");
    expect(out).toBe("ran");
    expect(lockKeys).toEqual(["addon:t1:CUSTOMER_PACK_100", "addon:t1:FORECASTING"]);
  });

  it("no SKU, no lock", async () => {
    expect(await withAddonLocks("t1", [], async () => 7)).toBe(7);
    expect(lockKeys).toEqual([]);
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
