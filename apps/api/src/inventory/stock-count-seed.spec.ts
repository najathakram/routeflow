import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { STOCK_TX_OPTIONS } from "../common/product-locks";
import {
  COUNT_SEED_BATCH,
  discardUnfinishedSeed,
  findOpenCountConflicts,
  seedStockCountLines,
  type SeedLine,
} from "./stock-count-seed";

/**
 * Row 562 S1: the batched line seeder. Each batch of COUNT_SEED_BATCH lines is its own transaction:
 * the batch's `stock-count-product` locks in ONE sorted statement, then the one-open-count-per-product
 * re-check, then a live-stock read (the baseline), then `createMany(skipDuplicates)`.
 */
const D = (n: number | string) => new Prisma.Decimal(n);
const pid = (i: number) => `p${String(i).padStart(4, "0")}`;
const line = (i: number, over: Partial<SeedLine> = {}): SeedLine => ({
  productId: pid(i),
  mode: "REPLACE",
  countedQty: D(7),
  boxes: null,
  pieces: null,
  ...over,
});

function fake() {
  const events: string[] = [];
  const stock = new Map<string, Prisma.Decimal>();
  const created: any[][] = [];
  const conflicts: Array<unknown[]> = [];
  // The session the seeder writes into: its status as the in-tx read sees it (one entry per read; the last
  // sticks), and whether the shared `stock-count` try-lock is granted (a committer holding it = false).
  const session = { statuses: ["OPEN"] as Array<string | null>, lockGranted: true };
  const tx: any = {
    $queryRaw: jest.fn((s: TemplateStringsArray, ...v: unknown[]) => {
      if (s.join("?").includes("pg_try_advisory_xact_lock_shared")) {
        events.push(`session-lock:${JSON.stringify(v)}`);
        return Promise.resolve([{ ok: session.lockGranted }]);
      }
      return Promise.resolve([]);
    }),
    $executeRaw: jest.fn((s: TemplateStringsArray, ...v: unknown[]) => {
      if (s.join("?").includes("pg_advisory_xact_lock")) events.push(`lock:${JSON.stringify(v)}`);
      return Promise.resolve(0);
    }),
    stockCountLine: {
      findMany: jest.fn(async () => {
        events.push("overlap");
        return conflicts.shift() ?? [];
      }),
      createMany: jest.fn(async (a: any) => {
        events.push("write");
        created.push(a.data);
        return { count: a.data.length };
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    stockCountSession: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => {
        events.push("session-status");
        const status = session.statuses.length > 1 ? session.statuses.shift() : session.statuses[0];
        return status === null ? null : { id: "s1", status };
      }),
    },
    product: {
      findMany: jest.fn(async (a: any) => {
        events.push("stock");
        return (a.where.id.in as string[])
          .filter((id) => stock.has(id))
          .map((id) => ({ id, currentStock: stock.get(id) }));
      }),
    },
  };
  const prisma: any = {
    getTenantId: () => "t1",
    tenantTransaction: jest.fn(async (fn: any, opts?: any) => {
      events.push("tx");
      return fn(tx, opts);
    }),
  };
  return { prisma, tx, events, stock, created, conflicts, session };
}

describe("seedStockCountLines (row 562 S1)", () => {
  it("the batch size is 200", () => {
    expect(COUNT_SEED_BATCH).toBe(200);
  });

  it("no lines: no transaction", async () => {
    const f = fake();
    await expect(
      seedStockCountLines(f.prisma, { sessionId: "s1", userId: "u1", lines: [] }),
    ).resolves.toEqual({ seeded: 0, batches: 0 });
    expect(f.prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("450 lines are 3 transactions (200, 200, 50), cut from the SORTED product ids, on the stock budget", async () => {
    const f = fake();
    const lines = Array.from({ length: 450 }, (_, i) => line(i + 1)).reverse();

    const res = await seedStockCountLines(f.prisma, { sessionId: "s1", userId: "u1", lines });

    expect(res).toEqual({ seeded: 450, batches: 3 });
    expect(f.created.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(f.created.flat().map((r) => r.productId)).toEqual(
      Array.from({ length: 450 }, (_, i) => pid(i + 1)),
    );
    expect(
      f.prisma.tenantTransaction.mock.calls.every((c: any[]) => c[1] === STOCK_TX_OPTIONS),
    ).toBe(true);
  });

  it("each batch: the shared count lock, THEN the session status, THEN ONE product-lock statement with its sorted keys, THEN the overlap read, THEN the stock read, THEN the write", async () => {
    const f = fake();
    await seedStockCountLines(f.prisma, {
      sessionId: "s1",
      userId: "u1",
      lines: [line(3), line(1), line(2)],
    });

    expect(f.events).toEqual([
      "tx",
      `session-lock:${JSON.stringify(["stock-count", "s1"])}`,
      "session-status",
      `lock:${JSON.stringify(["stock-count-product", ["t1:p0001", "t1:p0002", "t1:p0003"]])}`,
      "overlap",
      "stock",
      "write",
    ]);
  });

  it("writes plain rows (no tenantId: the tenant extension injects it), skipDuplicates, the baseline from the in-tx read", async () => {
    const f = fake();
    f.stock.set(pid(1), D(40));
    // pid(2) has no stock row: the baseline falls back to 0 (the FK, not this code, refuses a gone product)

    await seedStockCountLines(f.prisma, {
      sessionId: "s1",
      userId: "u1",
      lines: [line(1, { countedQty: D("12.5"), boxes: 1, pieces: 0, mode: "ADD" }), line(2)],
    });

    const call = f.tx.stockCountLine.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toEqual([
      {
        sessionId: "s1",
        productId: pid(1),
        mode: "ADD",
        countedQty: D("12.5"),
        boxes: 1,
        pieces: 0,
        expectedQty: D(40),
        countedById: "u1",
      },
      {
        sessionId: "s1",
        productId: pid(2),
        mode: "REPLACE",
        countedQty: D(7),
        boxes: null,
        pieces: null,
        expectedQty: D(0),
        countedById: "u1",
      },
    ]);
    expect(call.data.every((r: any) => !("tenantId" in r))).toBe(true);
  });

  it("a product given twice is one line (the table is unique per session and product)", async () => {
    const f = fake();
    const res = await seedStockCountLines(f.prisma, {
      sessionId: "s1",
      userId: "u1",
      lines: [line(1), line(1, { countedQty: D(9) })],
    });
    expect(res.seeded).toBe(1);
    expect(f.created[0]).toHaveLength(1);
    expect(f.created[0][0].countedQty).toEqual(D(7)); // the first one wins
  });

  it("a conflict in batch 2 throws the 409 with every conflict, writes nothing in that batch, and stops", async () => {
    const f = fake();
    f.conflicts.push(
      [],
      [
        {
          productId: pid(250),
          product: { name: "Widget" },
          session: { id: "o1", name: "Aisle 3" },
        },
      ],
    );

    const err: any = await seedStockCountLines(f.prisma, {
      sessionId: "s1",
      userId: "u1",
      lines: Array.from({ length: 450 }, (_, i) => line(i + 1)),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "PRODUCT_IN_OPEN_COUNT",
      conflicts: [{ productId: pid(250), sessionId: "o1", sessionName: "Aisle 3" }],
    });
    expect(f.created).toHaveLength(1); // batch 1 only
    expect(f.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
  });

  it("the overlap read looks only at OTHER open counts of the batch's products", async () => {
    const f = fake();
    await seedStockCountLines(f.prisma, { sessionId: "s1", userId: "u1", lines: [line(1)] });
    expect(f.tx.stockCountLine.findMany.mock.calls[0][0].where).toMatchObject({
      productId: { in: [pid(1)] },
      sessionId: { not: "s1" },
      session: { status: { in: ["OPEN", "REVIEW"] } },
    });
  });

  describe("the session lock and the OPEN check (562 S1 review fold)", () => {
    const code = (e: any) => ({ status: e?.getStatus?.(), code: e?.getResponse?.()?.code });
    const seed = (f: ReturnType<typeof fake>, n = 1, batchSize?: number) =>
      seedStockCountLines(f.prisma, {
        sessionId: "s1",
        userId: "u1",
        lines: Array.from({ length: n }, (_, i) => line(i + 1)),
        batchSize,
      });

    it("a committer holding the count lock: 409 STOCK_COUNT_COMMITTING before any product lock, read or write", async () => {
      const f = fake();
      f.session.lockGranted = false;

      const err: any = await seed(f).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(code(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(f.events.filter((e) => e.startsWith("lock:") || e === "overlap")).toEqual([]);
      expect(f.tx.stockCountLine.createMany).not.toHaveBeenCalled();
    });

    it.each(["COMMITTED", "DISCARDED", "REVIEW"])(
      "a %s session: the same 409, nothing written",
      async (status) => {
        const f = fake();
        f.session.statuses = [status];

        const err: any = await seed(f).catch((e) => e);

        expect(code(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
        expect(f.tx.stockCountLine.createMany).not.toHaveBeenCalled();
      },
    );

    it("a session that is gone is a 404, nothing written", async () => {
      const f = fake();
      f.session.statuses = [null];

      await expect(seed(f)).rejects.toBeInstanceOf(NotFoundException);
      expect(f.tx.stockCountLine.createMany).not.toHaveBeenCalled();
    });

    it("the status is read in EVERY batch: a commit between batch 1 and 2 stops the seed at once", async () => {
      const f = fake();
      f.session.statuses = ["OPEN", "COMMITTED"];

      const err: any = await seed(f, 3, 1).catch((e) => e);

      expect(code(err)).toEqual({ status: 409, code: "STOCK_COUNT_COMMITTING" });
      expect(f.created).toHaveLength(1); // batch 1 only, written while the count was OPEN
      expect(f.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    });
  });
});

describe("discardUnfinishedSeed", () => {
  it("deletes the lines and flips the session by CAS on OPEN / REVIEW, in one transaction", async () => {
    const f = fake();

    await discardUnfinishedSeed(f.prisma, "s1");

    expect(f.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(f.tx.stockCountLine.deleteMany).toHaveBeenCalledWith({ where: { sessionId: "s1" } });
    expect(f.tx.stockCountSession.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: { in: ["OPEN", "REVIEW"] } },
      data: { status: "DISCARDED", discardedAt: expect.any(Date) },
    });
  });

  it("takes the shared count lock first; a committer holding it keeps the session: nothing flipped, no line deleted", async () => {
    const f = fake();
    f.session.lockGranted = false;

    await discardUnfinishedSeed(f.prisma, "s1");

    expect(f.events).toEqual(["tx", `session-lock:${JSON.stringify(["stock-count", "s1"])}`]);
    expect(f.tx.stockCountSession.updateMany).not.toHaveBeenCalled();
    expect(f.tx.stockCountLine.deleteMany).not.toHaveBeenCalled();
  });
});

describe("findOpenCountConflicts", () => {
  it("de-duplicates, sorts by product then session, and skips the query for no ids", async () => {
    const db = {
      stockCountLine: {
        findMany: jest.fn(async () => [
          { productId: "b", product: { name: "B" }, session: { id: "s2", name: null } },
          { productId: "a", product: null, session: { id: "s9", name: "Nine" } },
          { productId: "b", product: { name: "B" }, session: { id: "s2", name: null } },
          { productId: "a", product: null, session: { id: "s1", name: "One" } },
        ]),
      },
    };

    expect(await findOpenCountConflicts(db as any, [])).toEqual([]);
    expect(db.stockCountLine.findMany).not.toHaveBeenCalled();

    const out = await findOpenCountConflicts(db as any, ["a", "b"]);
    expect(out.map((c) => `${c.productId}:${c.sessionId}`)).toEqual(["a:s1", "a:s9", "b:s2"]);
    expect(out[0].productName).toBeNull();
  });
});
