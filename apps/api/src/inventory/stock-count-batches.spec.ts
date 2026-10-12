import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { COUNT_COMMIT_BATCH } from "./stock-count-commit";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { LockUnavailableError } from "../common/db-locks";

/**
 * SA-767 L-2.2 (r-note 2 (b)), unit level: `commitStockCountSession` commits a durable count in
 * id-ordered batches of COUNT_COMMIT_BATCH lines under ONE session-scoped advisory lock. Each batch is
 * its own short `retryStockTx` tx (Product lock -> locked read -> per-line idempotent apply); the
 * session flips to COMMITTED by a CAS only after the LAST batch. The real-Postgres proofs are
 * `sa767-stock-writers.db.spec.ts` (r1-r5); this pins the shape on every unit run.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

const D = (n: number | string) => new Prisma.Decimal(n);
const pid = (i: number) => `p${String(i).padStart(3, "0")}`;
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

describe("commitStockCountSession - batched committer (SA-767 L-2.2)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let alerts: jest.SpyInstance;
  let stock: Map<string, Prisma.Decimal>;
  let txs: Array<{ $executeRaw: jest.Mock }>;
  /** Product ids passed to each lock statement, per tx (the `ANY(${ids}::text[])` argument). */
  let lockedIds: string[][];
  /** Event log in call order: "lock-acquired", "tx", "cas", "lock-released". */
  let events: string[];

  const line = (i: number, over: Record<string, unknown> = {}) => ({
    id: `line-${String(i).padStart(3, "0")}`,
    sessionId: "sess-1",
    productId: pid(i),
    mode: "REPLACE",
    countedQty: D(90),
    expectedQty: D(100),
    unitCostOverride: null,
    ...over,
  });
  const session = (lines: unknown[], over: Record<string, unknown> = {}) => ({
    id: "sess-1",
    status: "OPEN",
    movementReference: null,
    lines,
    ...over,
  });
  const seed = (ids: string[], currentStock = 100) => {
    stock = new Map(ids.map((id) => [id, D(currentStock)]));
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    events = [];
    txs = [];
    lockedIds = [];
    stock = new Map();
    mockWithAdvisoryLock.mockReset();
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => {
      events.push("lock-acquired");
      try {
        return { acquired: true, value: await fn() };
      } finally {
        events.push("lock-released");
      }
    });
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      events.push("tx");
      const mine: string[] = [];
      lockedIds.push(mine);
      const tx = {
        ...prisma,
        $executeRaw: jest.fn().mockImplementation((_s: unknown, ...rest: unknown[]) => {
          const ids = rest.find((v) => Array.isArray(v));
          if (ids) mine.push(...(ids as string[]));
          return Promise.resolve(0);
        }),
        // the shared stock-count lock probe: an explicit grant (the probe fails closed on anything else)
        $queryRaw: jest.fn().mockResolvedValue([{ ok: true }]),
      };
      txs.push(tx);
      return fn(tx);
    });
    prisma.product.findMany.mockImplementation(async (args: any) => {
      const wanted: string[] = args?.where?.id?.in ?? [...stock.keys()];
      return wanted
        .filter((id) => stock.has(id))
        .map((id) => ({
          id,
          name: id,
          kind: "STANDARD",
          isActive: true,
          currentStock: stock.get(id),
          averageCost: D(2),
          costingMethod: "AVCO",
          unitsPerBox: null,
        }));
    });
    prisma.product.update.mockImplementation(async ({ where, data }: any) => {
      const next = stock.get(where.id)!.plus(data.currentStock.increment);
      stock.set(where.id, next);
      return { currentStock: next };
    });
    let mv = 0;
    prisma.stockMovement.create.mockImplementation(async ({ data }: any) => ({
      id: `mv-${++mv}-${data.type}`,
    }));
    prisma.stockMovement.findMany.mockResolvedValue([]);
    prisma.stockCountSession.updateMany.mockImplementation(async () => {
      events.push("cas");
      return { count: 1 };
    });
    const mod = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = mod.get(InventoryService);
    alerts = jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
  });

  const commit = (dto: Record<string, unknown> = {}) =>
    service.commitStockCountSession("sess-1", dto as any, { sub: "user-1" });

  it("splits 120 lines into batches of 50 / 50 / 20, in productId order, one tx and one lock statement each", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => pid(i + 1));
    seed(ids);
    // Shuffled on purpose: the committer, not the caller, decides the order.
    const lines = ids.map((_, i) => line(i + 1)).reverse();
    prisma.stockCountSession.findUnique.mockResolvedValue(session(lines));

    const res: any = await commit();

    expect(COUNT_COMMIT_BATCH).toBe(50);
    expect(txs).toHaveLength(3);
    expect(lockedIds.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(lockedIds.flat()).toEqual(ids); // ascending productId across the batches
    expect(prisma.product.update).toHaveBeenCalledTimes(120);
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(120);
    expect(res).toMatchObject({
      sessionId: "sess-1",
      reference: "STOCK_COUNT-sess-1",
      applied: 120,
    });
    expect(res.movementIds).toHaveLength(120);
    expect(alerts).not.toHaveBeenCalled(); // REPLACE 100 -> 90: no positive delta, nothing restocked
  });

  it("holds ONE try-mode stock-count advisory lock across every batch, and flips the session by CAS only after the last one", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => pid(i + 1));
    seed(ids);
    prisma.stockCountSession.findUnique.mockResolvedValue(session(ids.map((_, i) => line(i + 1))));

    await commit({ notes: "aisle 3" });

    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(mockWithAdvisoryLock.mock.calls[0][0]).toEqual({
      family: "stock-count",
      key: "sess-1",
      mode: "try",
    });
    expect(events).toEqual(["lock-acquired", "tx", "tx", "cas", "lock-released"]);
    expect(prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
    const cas = prisma.stockCountSession.updateMany.mock.calls[0][0];
    expect(cas.where).toEqual({ id: "sess-1", status: { in: ["OPEN", "REVIEW"] } });
    expect(cas.data).toMatchObject({
      status: "COMMITTED",
      committedById: "user-1",
      movementReference: "STOCK_COUNT-sess-1",
      notes: "aisle 3",
    });
    expect(cas.data.committedAt).toBeInstanceOf(Date);
    // the old end-of-tx per-row update is gone
    expect(prisma.stockCountSession.update).not.toHaveBeenCalled();
  });

  it("REPLACE is counted minus the line's expectedQty (not the locked stock): a sale after the count survives", async () => {
    seed([pid(1)], 70); // expected 100 when counted; a sale of 30 landed since
    prisma.stockCountSession.findUnique.mockResolvedValue(
      session([line(1, { countedQty: D(90), expectedQty: D(100) })]),
    );

    await commit();

    // delta = 90 - 100 = -10 (the old locked-stock rule would have written +20 and erased the sale)
    expect(prisma.product.update.mock.calls[0][0].data).toEqual({
      currentStock: { increment: D(-10) },
    });
    const mv = prisma.stockMovement.create.mock.calls[0][0].data;
    expect(mv.quantity.toString()).toBe("-10");
    expect(mv.stockAfter.toString()).toBe("60"); // the counter the UPDATE returned (70 - 10)
    expect(mv.reference).toBe("STOCK_COUNT-sess-1");
    expect(stock.get(pid(1))!.toString()).toBe("60");
  });

  it("ADD applies the counted quantity as the delta", async () => {
    seed([pid(1)], 5);
    prisma.stockCountSession.findUnique.mockResolvedValue(
      session([line(1, { mode: "ADD", countedQty: D(4), expectedQty: D(5) })]),
    );

    await commit();

    expect(prisma.product.update.mock.calls[0][0].data).toEqual({
      currentStock: { increment: D(4) },
    });
    expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveBeenCalledWith([pid(1)]);
  });

  it("a line whose movement already exists (same reference + product) is skipped, not applied twice", async () => {
    seed([pid(1), pid(2)]);
    prisma.stockCountSession.findUnique.mockResolvedValue(session([line(1), line(2)]));
    // p001 was applied by an earlier, crashed run
    prisma.stockMovement.findMany.mockResolvedValue([
      { id: "mv-old", productId: pid(1), type: "ADJUSTMENT" },
    ]);

    const res: any = await commit();

    expect(prisma.stockMovement.findMany.mock.calls[0][0].where).toMatchObject({
      reference: "STOCK_COUNT-sess-1",
    });
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    expect(prisma.product.update.mock.calls[0][0].where).toEqual({ id: pid(2) });
    expect(res.applied).toBe(2); // the resumed one counts: the session's movement set is complete
    expect(res.movementIds).toEqual(expect.arrayContaining(["mv-old"]));
    expect(prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a second committer (try-lock busy) gets the coded 409 STOCK_COUNT_COMMITTING; nothing runs", async () => {
    seed([pid(1)]);
    prisma.stockCountSession.findUnique.mockResolvedValue(session([line(1)]));
    mockWithAdvisoryLock.mockResolvedValue({ acquired: false });

    const err: any = await commit().catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "STOCK_COUNT_COMMITTING" });
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
  });

  it("no lock connection is the coded 503 LOCK_UNAVAILABLE", async () => {
    seed([pid(1)]);
    prisma.stockCountSession.findUnique.mockResolvedValue(session([line(1)]));
    mockWithAdvisoryLock.mockRejectedValue(new LockUnavailableError(new Error("pool")));

    const err: any = await commit().catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
  });

  it("a 40P01 in batch 2 re-runs ONLY batch 2; its writes land once and batch 1 is not repeated", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => pid(i + 1));
    seed(ids);
    prisma.stockCountSession.findUnique.mockResolvedValue(session(ids.map((_, i) => line(i + 1))));
    // batch 2 starts at the 51st movement-existence read; fail its FIRST attempt at the lock statement
    let txNo = 0;
    const base = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
      txNo += 1;
      const failFirstOfBatch2 = txNo === 2;
      return base(async (tx: any) => {
        if (failFirstOfBatch2) throw deadlock();
        return fn(tx);
      }, opts);
    });

    await commit();

    expect(txNo).toBe(3); // batch 1, batch 2 (failed), batch 2 again
    expect(prisma.product.update).toHaveBeenCalledTimes(60); // each line exactly once
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(60);
    expect(prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a failure in batch 2 propagates: the CAS never runs, batch 1's alerts already fired, the lock is released", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => pid(i + 1));
    seed(ids);
    prisma.stockCountSession.findUnique.mockResolvedValue(
      // ADD lines: every batch-1 product is restocked, so batch 1 fires an alert
      session(ids.map((_, i) => line(i + 1, { mode: "ADD", countedQty: D(1) }))),
    );
    const boom = new BadRequestException("boom");
    let n = 0;
    prisma.stockMovement.create.mockImplementation(async () => {
      n += 1;
      if (n === 51) throw boom; // the first movement of batch 2
      return { id: `mv-${n}` };
    });

    await expect(commit()).rejects.toBe(boom);

    expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveBeenCalledWith(ids.slice(0, 50));
    expect(events[events.length - 1]).toBe("lock-released");
  });

  it("a cost line whose product is gone from the LOCKED read is a 404, not a TypeError", async () => {
    seed([pid(1)]);
    prisma.stockCountSession.findUnique.mockResolvedValue(
      session([line(1, { unitCostOverride: D(5) })]),
    );
    // present at the pre-lock and the under-lock validation reads, deleted before the batch tx
    // reads it under the product lock
    const base = prisma.product.findMany.getMockImplementation()!;
    prisma.product.findMany
      .mockImplementationOnce(base)
      .mockImplementationOnce(async (args: any) => {
        const rows = await base(args);
        stock.delete(pid(1));
        return rows;
      });

    const err: any = await commit().catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
  });

  it("a CAS that matches no row (someone else finished) returns the alreadyCommitted outcome", async () => {
    seed([pid(1)]);
    // pre-check: OPEN; the re-read (status + lines) under the lock: OPEN; the re-read after the failed CAS: COMMITTED
    prisma.stockCountSession.findUnique
      .mockResolvedValueOnce(session([line(1)]))
      .mockResolvedValueOnce(session([line(1)]))
      .mockResolvedValue({ status: "COMMITTED" });
    prisma.stockCountSession.updateMany.mockResolvedValue({ count: 0 });

    const res: any = await commit();

    expect(res).toMatchObject({ sessionId: "sess-1", alreadyCommitted: true });
  });

  it("the pre-checks stay outside the lock: not found, discarded and empty never take it", async () => {
    prisma.stockCountSession.findUnique.mockResolvedValue(null);
    await expect(commit()).rejects.toBeInstanceOf(NotFoundException);
    prisma.stockCountSession.findUnique.mockResolvedValue(
      session([line(1)], { status: "DISCARDED" }),
    );
    await expect(commit()).rejects.toBeInstanceOf(BadRequestException);
    prisma.stockCountSession.findUnique.mockResolvedValue(session([]));
    await expect(commit()).rejects.toBeInstanceOf(BadRequestException);
    prisma.stockCountSession.findUnique.mockResolvedValue(
      session([line(1)], { status: "COMMITTED", movementReference: "STOCK_COUNT-sess-1" }),
    );
    await expect(commit()).resolves.toMatchObject({ alreadyCommitted: true });
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
  });

  describe("a committing session refuses edits and discard (409 STOCK_COUNT_COMMITTING)", () => {
    const open = () =>
      prisma.stockCountSession.findFirst.mockResolvedValue({ id: "sess-1", status: "OPEN" });
    const edit = () =>
      service.upsertStockCountLine("sess-1", { productId: "prod-1", countedQty: 1 }, { sub: "u" });

    it.each([
      ["upsertStockCountLine", () => edit()],
      ["removeStockCountLine", () => service.removeStockCountLine("sess-1", "prod-1")],
      ["discardStockCountSession", () => service.discardStockCountSession("sess-1")],
    ])("%s", async (_n, call) => {
      open();
      prisma.stockMovement.findFirst.mockResolvedValue({ id: "mv-1" });

      const err: any = await call().catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "STOCK_COUNT_COMMITTING" });
      expect(prisma.stockMovement.findFirst.mock.calls[0][0].where).toMatchObject({
        reference: "STOCK_COUNT-sess-1",
      });
      expect(prisma.stockCountLine.create).not.toHaveBeenCalled();
      expect(prisma.stockCountLine.update).not.toHaveBeenCalled();
      expect(prisma.stockCountLine.deleteMany).not.toHaveBeenCalled();
      expect(prisma.stockCountSession.update).not.toHaveBeenCalled();
    });

    it("an OPEN session with no movements is still editable and discardable", async () => {
      open();
      prisma.stockMovement.findFirst.mockResolvedValue(null);
      prisma.stockCountSession.findUnique.mockResolvedValue({ id: "sess-1", status: "DISCARDED" });

      await expect(service.removeStockCountLine("sess-1", "prod-1")).resolves.toEqual({
        removed: true,
      });
      await expect(service.discardStockCountSession("sess-1")).resolves.toMatchObject({
        status: "DISCARDED",
      });
    });
  });
});
