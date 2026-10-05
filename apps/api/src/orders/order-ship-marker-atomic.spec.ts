/**
 * SA-689 residual: the ship-state marker (an `OrderRevision` row, `order-ship-state.ts`) commits in the SAME
 * transaction as the status change. A lost REOPENED marker reads as "unmarked", which fails OPEN: the order
 * becomes cancellable, deletable or demotable while its goods are with the carrier. So a marker that cannot
 * be written must roll the status change back (the operator retries), never leave the status changed alone.
 *
 * The fake `tenantTransaction` is real in the one way that matters: it works on a COPY of the committed
 * state and keeps the copy only when the callback resolves, so a throw rolls everything back.
 */
import { OrderStatus } from "@prisma/client";
import { updateStatusWithShipMarker } from "./order-ship-state";

type State = {
  status: OrderStatus;
  revisions: Array<{
    orderId: string;
    revisionNumber: number;
    source: string;
    reason: string | null;
  }>;
};

const makeDb = (
  opts: {
    markerFails?: boolean;
    statusFails?: boolean;
    delivered?: boolean;
    start?: OrderStatus;
  } = {},
) => {
  const committed: State = { status: opts.start ?? OrderStatus.DELIVERED, revisions: [] };
  const delegates = (state: State, inTx: boolean) => ({
    order: {
      update: async ({ data }: any) => {
        if (opts.statusFails && inTx) throw new Error("status update failed");
        state.status = data.status;
        return { id: "o1", status: state.status };
      },
    },
    orderItem: {
      findMany: async () => [],
      findFirst: async () => (opts.delivered ? { id: "li-1" } : null),
    },
    orderRevision: {
      aggregate: async () => ({
        _max: { revisionNumber: Math.max(0, ...state.revisions.map((r) => r.revisionNumber)) },
      }),
      create: async ({ data }: any) => {
        if (opts.markerFails) throw new Error("marker insert failed");
        state.revisions.push(data);
      },
    },
  });
  const txCalls = { count: 0 };
  const prisma: any = {
    getTenantId: () => "t1",
    forTenant: () => delegates(committed, false),
    tenantTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      txCalls.count++;
      const draft: State = { status: committed.status, revisions: [...committed.revisions] };
      const result = await fn(delegates(draft, true));
      committed.status = draft.status; // commit only when the callback resolved
      committed.revisions = draft.revisions;
      return result;
    },
  };
  return { committed, prisma, txCalls };
};

const cfg = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });
const order = (status: OrderStatus, over: Record<string, unknown> = {}) => ({
  id: "o1",
  tenantId: "t1",
  status,
  fulfillPath: "SHIP" as const,
  subtotal: 10,
  tax: 0,
  total: 10,
  ...over,
});
const run = (
  db: ReturnType<typeof makeDb>,
  from: OrderStatus,
  to: OrderStatus,
  { mode = "ship", over = {} }: { mode?: string; over?: Record<string, unknown> } = {},
) =>
  updateStatusWithShipMarker(
    { prisma: db.prisma, featureConfig: cfg(mode) },
    order(from, over),
    { status: to, reason: "r" },
    undefined,
    { status: to },
  );

describe("SA-689: the ship-state marker commits with the status change", () => {
  it("a marker that cannot be written rolls the status change back (never a status with no marker)", async () => {
    const db = makeDb({ markerFails: true });
    await expect(run(db, OrderStatus.DELIVERED, OrderStatus.CONFIRMED)).rejects.toThrow(
      "marker insert failed",
    );
    expect(db.committed.status).toBe(OrderStatus.DELIVERED); // red before the fix: CONFIRMED, unmarked
    expect(db.committed.revisions).toEqual([]);
  });

  it("the same for an unmark and for a reopen to PARTIALLY_DELIVERED", async () => {
    for (const [from, to] of [
      [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED],
      [OrderStatus.DELIVERED, OrderStatus.PARTIALLY_DELIVERED],
    ] as const) {
      const db = makeDb({ markerFails: true, start: from });
      await expect(run(db, from, to)).rejects.toThrow();
      expect(db.committed.status).toBe(from);
    }
  });

  it("a status write that fails leaves no marker", async () => {
    const db = makeDb({ statusFails: true });
    await expect(run(db, OrderStatus.DELIVERED, OrderStatus.CONFIRMED)).rejects.toThrow(
      "status update failed",
    );
    expect(db.committed.revisions).toEqual([]);
  });

  it("success: the status and its marker land together, in one transaction", async () => {
    const db = makeDb();
    const row = await run(db, OrderStatus.DELIVERED, OrderStatus.CONFIRMED);
    expect(row).toMatchObject({ id: "o1", status: OrderStatus.CONFIRMED });
    expect(db.committed.status).toBe(OrderStatus.CONFIRMED);
    expect(db.committed.revisions).toMatchObject([
      { orderId: "o1", source: "REOPENED_FROM_DELIVERY", reason: "r", revisionNumber: 1 },
    ]);
    expect(db.txCalls.count).toBe(1);
  });

  it("#3219 S1 holds in the transaction: an unmark after a partial delivery records a REOPEN", async () => {
    const db = makeDb({ delivered: true, start: OrderStatus.OUT_FOR_DELIVERY });
    await run(db, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED);
    expect(db.committed.revisions.map((r) => r.source)).toEqual(["REOPENED_FROM_DELIVERY"]);
    const clean = makeDb({ start: OrderStatus.OUT_FOR_DELIVERY });
    await run(clean, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED);
    expect(clean.committed.revisions.map((r) => r.source)).toEqual(["UNMARKED_SHIPPED"]);
  });

  it("no marker due (another transition, a ROUTE order, a business that does not bill at shipment): a plain update, no transaction", async () => {
    const cases: Array<[OrderStatus, OrderStatus, Parameters<typeof run>[3]]> = [
      [OrderStatus.CONFIRMED, OrderStatus.OUT_FOR_DELIVERY, {}],
      [OrderStatus.DELIVERED, OrderStatus.CONFIRMED, { over: { fulfillPath: "ROUTE" } }],
      [OrderStatus.DELIVERED, OrderStatus.CONFIRMED, { mode: "unset" }],
    ];
    for (const [from, to, o] of cases) {
      const db = makeDb({ start: from, markerFails: true }); // a marker write would throw: none is attempted
      await expect(run(db, from, to, o)).resolves.toMatchObject({ status: to });
      expect(db.txCalls.count).toBe(0);
      expect(db.committed.status).toBe(to);
      expect(db.committed.revisions).toEqual([]);
    }
  });

  it("wiring pins: changeStatus writes status + marker through the one helper; no best-effort marker call remains", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src: string = require("fs").readFileSync(
      require("path").join(__dirname, "orders.service.ts"),
      "utf8",
    );
    expect(src).toMatch(/updateStatusWithShipMarker\(\s*this,/);
    expect(src).not.toMatch(/recordShipStateChange/);
  });
});
