import { observeRunCredit, RUN_CREDIT_LOG_CAP } from "./run-credit-observation";

/**
 * B585 — the run-start credit observation is log-only. The client answers by the SHAPE of the
 * query: the run's orders (`routeRunId`), the customers, and the shared reader's invoice / open
 * order reads — which is real `loadCreditExposure`, so the figure is the one the hard block uses.
 */
const RUN = "run-1";
const TENANT = "t-1";

function makeDb(
  over: {
    runOrders?: Array<{ orderNumber: string | null; customerId: string }>;
    openOrders?: Array<{ id: string; total: number }>;
    customers?: Array<{ id: string; creditLimit: unknown }>;
    invoices?: (customerId: string) => unknown[];
    fail?: boolean;
  } = {},
) {
  const runOrders = over.runOrders ?? [];
  return {
    order: {
      findMany: jest.fn(async ({ where }: any) => {
        if (over.fail) throw new Error("db down");
        return where.routeRunId ? runOrders : (over.openOrders ?? []); // the reader's open-order read
      }),
    },
    customer: { findMany: jest.fn(async () => over.customers ?? []) },
    invoice: {
      findMany: jest.fn(async ({ where }: any) => (over.invoices ?? (() => []))(where.customerId)),
    },
  };
}
const sent = (total: number) => ({
  total,
  status: "SENT",
  orderId: null,
  order: null,
  payments: [],
});
const run = (db: ReturnType<typeof makeDb>) => {
  const logger = { warn: jest.fn() };
  return { logger, done: observeRunCredit({ db, logger, tenantId: TENANT }, RUN) };
};

describe("observeRunCredit", () => {
  it("logs ONE line per over-limit customer: tenant, run, customer id, order NUMBERS, exposure, limit — nothing else", async () => {
    const db = makeDb({
      runOrders: [
        { orderNumber: "ORD-1", customerId: "c-1" },
        { orderNumber: "ORD-2", customerId: "c-1" },
        { orderNumber: "ORD-3", customerId: "c-2" },
      ],
      customers: [
        { id: "c-1", creditLimit: "100.00" },
        { id: "c-2", creditLimit: 500 },
      ],
      invoices: (c) => (c === "c-1" ? [sent(150)] : [sent(20)]),
    });
    const { logger, done } = run(db);
    await done;

    expect(logger.warn).toHaveBeenCalledTimes(1); // c-2 is within its limit
    expect(logger.warn).toHaveBeenCalledWith(
      "run start (observation only): customer over credit limit: tenant=t-1 run=run-1 " +
        "customer=c-1 orders=ORD-1,ORD-2 exposure=150 limit=100",
    );
  });

  it("a run order is counted ONCE: it is already one of the customer's open orders (90, not 180)", async () => {
    const db = makeDb({
      runOrders: [{ orderNumber: "ORD-1", customerId: "c-1" }],
      openOrders: [{ id: "o-1", total: 90 }],
      customers: [{ id: "c-1", creditLimit: 80 }],
    });
    const { logger, done } = run(db);
    await done;
    expect(logger.warn.mock.calls[0][0]).toContain("exposure=90 limit=80");
  });

  it("only OPEN orders on the run are considered, and a customer with no limit is never read for exposure", async () => {
    const db = makeDb({
      runOrders: [{ orderNumber: "ORD-1", customerId: "c-1" }],
      customers: [{ id: "c-1", creditLimit: null }],
      invoices: () => [sent(1_000_000)],
    });
    const { logger, done } = run(db);
    await done;

    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.routeRunId).toBe(RUN);
    expect(new Set(where.status.in)).toEqual(new Set(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"]));
    expect(db.invoice.findMany).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is rate-limited: at most RUN_CREDIT_LOG_CAP customer lines, then ONE summary line", async () => {
    const n = RUN_CREDIT_LOG_CAP + 5;
    const ids = Array.from({ length: n }, (_v, i) => `c-${i}`);
    const db = makeDb({
      runOrders: ids.map((customerId, i) => ({ orderNumber: `ORD-${i}`, customerId })),
      customers: ids.map((id) => ({ id, creditLimit: 1 })),
      invoices: () => [sent(50)],
    });
    const { logger, done } = run(db);
    await done;

    expect(logger.warn).toHaveBeenCalledTimes(RUN_CREDIT_LOG_CAP + 1);
    expect(logger.warn.mock.calls.at(-1)?.[0]).toContain(
      "5 more customer(s) over their credit limit",
    );
  });

  it("caps the order numbers listed on one line", async () => {
    const db = makeDb({
      runOrders: Array.from({ length: 13 }, (_v, i) => ({
        orderNumber: `O${i}`,
        customerId: "c-1",
      })),
      customers: [{ id: "c-1", creditLimit: 1 }],
      invoices: () => [sent(50)],
    });
    const { logger, done } = run(db);
    await done;
    expect(logger.warn.mock.calls[0][0]).toContain("orders=O0,O1,O2,O3,O4,O5,O6,O7,O8,O9,+3 ");
  });

  it("never throws: a failed read is ONE unavailable line, even if the logger itself throws", async () => {
    const db = makeDb({ fail: true });
    const { logger, done } = run(db);
    await expect(done).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("observation unavailable"));

    const broken = {
      warn: jest.fn(() => {
        throw new Error("logger down");
      }),
    };
    await expect(
      observeRunCredit({ db: makeDb({ fail: true }), logger: broken, tenantId: null }, RUN),
    ).resolves.toBeUndefined();
  });
});
