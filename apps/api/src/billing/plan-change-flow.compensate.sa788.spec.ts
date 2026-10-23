/**
 * SA-788 / SA-815e - the compensating revert of a failed plan change moves an add-on row's Stripe pointer and
 * records it through the one writer. The pointer write, the row lock and the `addon.state_changed` record must
 * commit TOGETHER (one transaction, opened here because the failed local write's own transaction has ended): a record
 * that fails to write rolls the pointer back too, so no pointer ever moves without its trace (an unrecorded pointer
 * change is false bypass evidence for the daily invariant).
 *
 * Red on the previous code: `updateAddonRowsTx(prisma as TransactionClient, ...)` ran on the bare client, so the lock
 * was a no-op and the updateMany and the emit committed separately: a throwing emit left the moved pointer behind.
 */
jest.mock("./needs-reconcile", () =>
  require("../testing/needs-reconcile-mock").needsReconcileMock(),
);
jest.mock("./plan-change-stripe", () => ({
  ...jest.requireActual("./plan-change-stripe"),
  pushPlanChange: jest.fn(),
  revertPlanChange: jest.fn(),
}));
import { markNeedsReconcile } from "./needs-reconcile";
import { pushPlanChange, revertPlanChange } from "./plan-change-stripe";
import { beginStripeFirstPlanChange, planChangeArgs } from "./plan-change-flow";

type Row = { id: string; tenantId: string; stripeItemId: string | null; [k: string]: unknown };

function rig(opts: { emitThrows?: boolean } = {}) {
  let rows: Row[] = [
    {
      id: "r1",
      tenantId: "t1",
      addonKey: "FORECASTING",
      sku: "FORECASTING",
      active: true,
      quantity: 1,
      priceSnapshot: 0,
      isComp: false,
      stripeItemId: "si_dead",
      stripePriceId: null,
    },
  ];
  let records: unknown[][] = [];
  const locks: string[] = [];
  const match = (r: Row, w: any = {}): boolean =>
    Object.entries(w).every(([k, v]) =>
      k === "AND"
        ? ([] as any[]).concat(v as any).every((x) => match(r, x))
        : v && typeof v === "object" && "in" in (v as object)
          ? (v as { in: unknown[] }).in.includes((r as any)[k])
          : (r as any)[k] === v,
    );
  const tx: any = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      locks.push(strings.join("?").includes('"Tenant"') ? "tenant" : "addon-row");
      return [];
    }),
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => match(r, where)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
  };
  const events: any = {
    emit: jest.fn(async (...args: unknown[]) => {
      if (opts.emitThrows) throw new Error("emit failed");
      records.push(args);
      return {};
    }),
  };
  // a transaction that really rolls back: rows and records revert when the callback throws
  const transaction = jest.fn(async (fn: any) => {
    const savedRows = rows.map((r) => ({ ...r }));
    const savedRecords = [...records];
    try {
      return await fn(tx);
    } catch (e) {
      rows = savedRows;
      records = savedRecords;
      throw e;
    }
  });
  // the BARE client behaves like a real one: statements outside a transaction commit one by one (so the old code,
  // which wrote through it, leaves a moved pointer behind when its record then fails)
  const prisma: any = {
    $transaction: transaction,
    $queryRaw: tx.$queryRaw,
    tenantAddon: tx.tenantAddon,
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({ planKey: "SCALE", planVersionId: "v7" }),
    },
  };
  const stripe: any = {
    isConfigured: true,
    getSubscription: jest.fn().mockResolvedValue({
      items: { data: [{ id: "si_base", price: { unit_amount: 24900, product: "prod_new" } }] },
    }),
  };
  const logger: any = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  (pushPlanChange as jest.Mock).mockResolvedValue({
    pushed: true,
    tenantId: "t1",
    stripeSubId: "sub_1",
    proration: "none",
    key: "k1",
    settledItemIds: new Set<string>(),
    newAmountCents: 24900,
    productId: "prod_new",
    revert: {
      baseId: "si_base",
      baseBefore: {},
      baseChanged: true,
      restore: [{ rowId: "r1" }],
    },
  });
  (revertPlanChange as jest.Mock).mockResolvedValue([{ rowId: "r1", newItemId: "si_new" }]);
  return {
    prisma,
    stripe,
    logger,
    events,
    transaction,
    locks,
    rows: () => rows,
    records: () => records,
  };
}

const args = () =>
  planChangeArgs({
    tenantId: "t1",
    sub: { stripeSubId: "sub_1", planKey: "SCALE" },
    version: { id: "v8", addonSkus: [] },
    def: { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, annualPrice: null },
    proration: "none",
    stopBillingAddons: false,
  });

beforeEach(() => jest.clearAllMocks());

describe("SA-788: the compensating revert's pointer write and its record are ONE transaction", () => {
  it("a restored add-on item re-points its row and writes ONE plan_change.revert record, locking the Tenant row first", async () => {
    const r = rig();
    const flow = await beginStripeFirstPlanChange(r, args());
    await expect(flow.settle(Promise.reject(new Error("local write failed")))).rejects.toThrow(
      "local write failed",
    );

    expect(r.transaction).toHaveBeenCalledTimes(1);
    expect(r.rows()[0].stripeItemId).toBe("si_new");
    expect(r.records()).toHaveLength(1);
    expect((r.records()[0][2] as any).source).toBe("plan_change.revert");
    expect(r.locks[0]).toBe("tenant"); // the house order: Tenant row first, then the add-on row
    expect(r.locks).toEqual(["tenant", "addon-row"]);
  });

  it("an emit that throws rolls the pointer back too: no pointer change AND no record", async () => {
    const r = rig({ emitThrows: true });
    const flow = await beginStripeFirstPlanChange(r, args());
    await expect(flow.settle(Promise.reject(new Error("local write failed")))).rejects.toThrow(
      "local write failed",
    );

    expect(r.rows()[0].stripeItemId).toBe("si_dead"); // not "si_new"
    expect(r.records()).toEqual([]);
    expect(markNeedsReconcile).toHaveBeenCalled(); // the pointer inconsistency still raises the flag
  });
});
