/**
 * SA-767 L-2 (B286 / #2840) - the manual stock / cost writers lock the Product row FIRST, read the
 * stock and the average INSIDE the tx, and write relatively. Real Postgres, separate connections.
 *
 * Every case is a deterministic interleave, no sleep decides an outcome:
 *   1. writer A runs its whole body inside its tx and is then HELD open before COMMIT (a wrapper on
 *      `tenantTransaction`), so it still owns the Product row lock;
 *   2. writer B is started; its pre-tx validation read sees A's UNCOMMITTED-away state (the stale
 *      read the old code computed from);
 *   3. the spec polls `pg_blocking_pids` until B is genuinely WAITING on a lock (the B916 rule: the
 *      lock wait must be observed, not assumed), then releases A.
 * On the old code B is blocked at its first Product write; on the new code at the lock statement.
 * Either way the contention is real and the final state tells the two apart.
 *
 *  (a)  two concurrent recordPurchase: the final average is the TRUE weighted average of both applied
 *       in the serialized order, and the second movement's avgCostAfter derives from the first's.
 *  (b1) commitStockCount landing AFTER a sale replaces the post-sale stock (counted 90, delta 90 - 70).
 *  (b2) a sale landing AFTER a count is not erased (regression guard, the old code was already right).
 *  (b3) commitStockCountSession after a sale: cost row and adjustment come from the locked rows.
 *  (c)  setCostBasis racing a sale stamps the locked stock (stockAfter 70), not the stale read.
 *  (c-bulk) bulkSetCostBasis locks every product in one statement and stamps each locked stock.
 *  (d)  recordAdjustment racing a purchase takes avgCostAfter and the lot cost from the locked row.
 *  (e1) the same all-zero-delta session committed twice concurrently applies ONCE (session CAS).
 *  (e1b) a duplicate commit that read the session before the first landed cannot erase a later sale.
 *  (e2) a line saved after the pre-tx read is committed with the session, never silently dropped.
 *
 * `sawLockWait(holderPid)` only counts a backend blocked BY the holder's connection, so another DB
 * lane waiting on its own locks in the same database cannot fake the observation.
 *
 * Collected only by `jest.db.config.js`, run via `npm run test:db`. `requireLocalDatabaseUrl()`
 * refuses any non-local host. Tenants are throwaway `qa-sa767-l2-<run>-<n>-<label>` slugs approved by
 * `assertTestTenant`; `afterAll` deletes exactly what this run created, in FK order.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa767-l2-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "sa767-stock-writers.db.spec",
  );
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holds a transaction open after its body ran, until released. */
class Gate {
  private markParked!: () => void;
  private open!: () => void;
  /** Resolves when the held transaction's body has finished (it still owns its locks). */
  readonly parked = new Promise<void>((r) => {
    this.markParked = r;
  });
  private readonly opened = new Promise<void>((r) => {
    this.open = r;
  });
  /** The backend pid of the connection holding the transaction open (set by `hold`). */
  holderPid = 0;
  hold(holderPid: number): Promise<void> {
    this.holderPid = holderPid;
    this.markParked();
    return this.opened;
  }
  release(): void {
    this.open();
  }
}

interface Services {
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  inventory: InventoryService;
}

describeDb("SA-767 L-2 - stock writers lock, re-read in-tx, write relatively", () => {
  const services: Services[] = [];
  const createdTenantIds: string[] = [];
  const gates: Gate[] = [];
  const openClients: import("pg").PoolClient[] = [];
  let pool: Pool;

  async function build(): Promise<Services> {
    const tenantCtx = new TenantContextService();
    const prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    const s = { prisma, tenantCtx, inventory: module.get(InventoryService) };
    services.push(s);
    return s;
  }

  let A: Services; // the held writer + all seeding and reads
  let B: Services; // the competing writer, on its own connection pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    A = await build();
    B = await build();
  }, 120_000);

  afterEach(() => {
    gates.splice(0).forEach((g) => g.release());
    // a failed case must not leave a sale holding a row lock for the next one
    openClients.splice(0).forEach((c) => {
      void c
        .query("ROLLBACK")
        .catch(() => undefined)
        .finally(() => c.release(true));
    });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const prisma = A?.prisma;
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.stockCountLine.deleteMany({ where: { tenantId } });
        await prisma.stockCountSession.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // Never mask a test's own result, but never hide a leaked tenant either.
        // eslint-disable-next-line no-console
        console.error(`SA-767 L-2 spec cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await Promise.all(services.map((s) => s.prisma.$disconnect()));
    await pool?.end();
  }, 120_000);

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
  }

  async function seedWorld(label: string, stock: number, avg: number | null): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await A.prisma.tenant.create({ data: { slug, name: `SA-767 L-2 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await A.prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const supplier = await A.prisma.supplier.create({
      data: { name: `Supplier ${slug}`, tenantId: tenant.id },
    });
    const product = await A.prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        averageCost: avg,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id, supplierId: supplier.id, productId: product.id };
  }

  const inTenant = <T>(s: Services, w: World, fn: () => Promise<T>) =>
    s.tenantCtx.run(w.tenantId, fn);
  const productOf = (w: World) =>
    A.prisma.product.findUniqueOrThrow({ where: { id: w.productId } });
  const movementsOf = (w: World) =>
    A.prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

  /**
   * The FIRST `tenantTransaction` of `svc` runs its body, then parks (still holding every lock the
   * body took) until the gate is released. Later calls (a retry) run untouched.
   */
  function holdFirstTxOpen(svc: Services): Gate {
    const gate = new Gate();
    gates.push(gate);
    const original = svc.prisma.tenantTransaction.bind(svc.prisma) as any;
    let first = true;
    jest.spyOn(svc.prisma, "tenantTransaction").mockImplementation(((fn: any, opts?: any) => {
      if (!first) return original(fn, opts);
      first = false;
      return original(
        async (tx: any) => {
          const result = await fn(tx);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await gate.hold(pid);
          return result;
        },
        { ...opts, timeout: 30_000, maxWait: 15_000 },
      );
    }) as any);
    return gate;
  }

  /**
   * True once some backend is genuinely WAITING on a lock held by `holderPid` (the holder
   * connection's pg_backend_pid()). Filtering on the blocker means a parallel DB lane waiting on its
   * own locks in the same database can never produce a false true.
   */
  async function sawLockWait(holderPid: number, withinMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND pg_blocking_pids(pid) @> ARRAY[$1::int]`,
        [holderPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    return false;
  }

  it("(a) two concurrent purchases blend in the serialized order: 10 @ 2.00 +10 @ 4 +20 @ 6 = 40 @ 4.50", async () => {
    const w = await seedWorld("a", 10, 2);
    const gateA = holdFirstTxOpen(A);

    const purchaseA = inTenant(A, w, () =>
      A.inventory.recordPurchase({ productId: w.productId, quantity: 10, unitCost: 4 }, w.userId),
    );
    await gateA.parked; // A wrote its blend (avg 3.00, stock 20) and still holds the row, uncommitted
    // B validates against the committed row (10 @ 2.00): the stale read the old code blended from.
    const purchaseB = inTenant(B, w, () =>
      B.inventory.recordPurchase({ productId: w.productId, quantity: 20, unitCost: 6 }, w.userId),
    );
    const waited = await sawLockWait(gateA.holderPid);
    gateA.release();
    await Promise.all([purchaseA, purchaseB]);

    const p = await productOf(w);
    const moves = await movementsOf(w);
    const lots = await A.prisma.stockLot.findMany({ where: { tenantId: w.tenantId } });
    console.log(
      `SA-767(a) observed: lockWait=${waited} stock=${p.currentStock} avg=${p.averageCost} ` +
        `moves=${moves.map((m) => `${m.quantity}@${m.avgCostAfter}/${m.stockAfter}`).join(" ")}`,
    );
    expect(waited).toBe(true); // B really waited behind A's row lock
    expect(Number(p.currentStock)).toBe(40);
    // (20 * 3.00 + 20 * 6) / 40 = 4.50; the old code wrote (10 * 2 + 20 * 6) / 30 = 4.6667
    expect(Number(p.averageCost)).toBe(4.5);
    expect(moves).toHaveLength(2);
    // A's blend (10 @ 2 + 10 @ 4 = 20 @ 3.00), then B's derives from it, not from the stale 2.00
    expect(Number(moves[0].avgCostAfter)).toBe(3);
    expect(Number(moves[0].stockAfter)).toBe(20);
    expect(Number(moves[1].avgCostAfter)).toBe(4.5);
    expect(Number(moves[1].stockAfter)).toBe(40);
    expect(lots).toHaveLength(2);
  }, 60_000);

  /** A SALE in flight (what `decrementStockForSale` does): holds the Product row, decremented, uncommitted. */
  async function openSale(w: World, qty: number, productId = w.productId) {
    const c = await pool.connect();
    openClients.push(c);
    await c.query("BEGIN");
    const { rows: pidRows } = await c.query("SELECT pg_backend_pid() AS pid");
    await c.query('SELECT id FROM "Product" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE', [
      productId,
      w.tenantId,
    ]);
    await c.query(
      'UPDATE "Product" SET "currentStock" = "currentStock" - $2 WHERE id = $1 RETURNING "currentStock"',
      [productId, qty],
    );
    return {
      pid: pidRows[0].pid as number,
      async commit() {
        await c.query("COMMIT");
        openClients.splice(openClients.indexOf(c), 1);
        c.release();
      },
    };
  }

  /** A sale that arrives while a writer holds the row: blocks on it, lands after, returns the counter it left. */
  async function saleAfter(w: World, qty: number): Promise<number> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query('SELECT id FROM "Product" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE', [
        w.productId,
        w.tenantId,
      ]);
      const { rows } = await c.query(
        'UPDATE "Product" SET "currentStock" = "currentStock" - $2 WHERE id = $1 RETURNING "currentStock"',
        [w.productId, qty],
      );
      await c.query("COMMIT");
      return Number(rows[0].currentStock);
    } finally {
      c.release();
    }
  }

  async function addProduct(w: World, stock: number, avg: number | null) {
    return A.prisma.product.create({
      data: {
        name: `Widget ${randomUUID().slice(0, 8)}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        averageCost: avg,
        costingMethod: "AVCO",
        tenantId: w.tenantId,
      },
    });
  }

  it("(d) an adjustment racing a purchase takes its avgCostAfter and lot cost from the LOCKED row", async () => {
    const w = await seedWorld("d", 10, 2);
    const gateA = holdFirstTxOpen(A);

    const purchase = inTenant(A, w, () =>
      A.inventory.recordPurchase({ productId: w.productId, quantity: 10, unitCost: 4 }, w.userId),
    );
    await gateA.parked; // avg 2.00 -> 3.00, stock 20, uncommitted
    // B validates against the committed row (avg 2.00): the stale read the old code stamped.
    const adjustment = inTenant(B, w, () =>
      B.inventory.recordAdjustment({ productId: w.productId, quantity: 5 }, w.userId),
    );
    const waited = await sawLockWait(gateA.holderPid);
    gateA.release();
    await Promise.all([purchase, adjustment]);

    const p = await productOf(w);
    const moves = await movementsOf(w);
    const adj = moves.find((m) => m.type === "ADJUSTMENT")!;
    const lot = await A.prisma.stockLot.findFirstOrThrow({
      where: { tenantId: w.tenantId, reference: "ADJUSTMENT" },
    });
    console.log(
      `SA-767(d) observed: lockWait=${waited} stock=${p.currentStock} avg=${p.averageCost} ` +
        `adjAvgCostAfter=${adj.avgCostAfter} adjStockAfter=${adj.stockAfter} lotCost=${lot.unitCost}`,
    );
    expect(waited).toBe(true);
    expect(Number(p.currentStock)).toBe(25);
    expect(Number(p.averageCost)).toBe(3); // an adjustment never moves the average
    expect(Number(adj.stockAfter)).toBe(25);
    expect(Number(adj.avgCostAfter)).toBe(3); // the old code stamped the stale 2.00
    expect(Number(lot.unitCost)).toBe(3);
  }, 60_000);

  const countDto = (qty: number, productId: string) => ({
    sessionId: randomUUID(),
    items: [{ productId, quantity: qty, mode: "REPLACE" as const }],
  });

  it("(b1) a count that lands AFTER a sale replaces the post-sale stock: counted 90, not 100 - 10 - 30", async () => {
    const w = await seedWorld("b1", 100, 2);
    const sale = await openSale(w, 30); // stock 70, uncommitted, row held

    // The count validates against the committed 100 (the stale read), then enters its tx.
    const count = inTenant(A, w, () =>
      A.inventory.commitStockCount(countDto(90, w.productId), w.userId),
    );
    const waited = await sawLockWait(sale.pid);
    await sale.commit();
    await count;

    const p = await productOf(w);
    const [m] = await movementsOf(w);
    console.log(
      `SA-767(b1) observed: lockWait=${waited} stock=${p.currentStock} delta=${m.quantity} ` +
        `stockAfter=${m.stockAfter}`,
    );
    expect(waited).toBe(true);
    // The count asserts 90 on hand and landed after the sale: the row is 90, the delta is 90 - 70.
    expect(Number(p.currentStock)).toBe(90);
    expect(Number(m.quantity)).toBe(20);
    expect(Number(m.stockAfter)).toBe(Number(p.currentStock));
  }, 60_000);

  it("(b2) a sale that lands AFTER a count is not erased: counted 90 - 30 = 60 (regression guard, not a red)", async () => {
    // Old code is already correct here (the count's increment commits before the sale's row lock
    // is granted); this pins that the fix keeps it so.
    const w = await seedWorld("b2", 100, 2);
    const gateA = holdFirstTxOpen(A);

    const count = inTenant(A, w, () =>
      A.inventory.commitStockCount(countDto(90, w.productId), w.userId),
    );
    await gateA.parked; // the count is written (stock 90) and still holds the row
    const sale = saleAfter(w, 30);
    const waited = await sawLockWait(gateA.holderPid);
    gateA.release();
    const [, left] = await Promise.all([count, sale]);

    const p = await productOf(w);
    const [m] = await movementsOf(w);
    expect(waited).toBe(true);
    expect(Number(p.currentStock)).toBe(60);
    expect(left).toBe(60);
    expect(Number(m.quantity)).toBe(-10);
    expect(Number(m.stockAfter)).toBe(90);
  }, 60_000);

  it("(b3) a durable-session commit after a sale: stock = counted, cost row + adjustment from the locked rows", async () => {
    const w = await seedWorld("b3", 100, 2);
    const session = await A.prisma.stockCountSession.create({
      data: { tenantId: w.tenantId, startedById: w.userId, name: "sa767" },
    });
    await A.prisma.stockCountLine.create({
      data: {
        tenantId: w.tenantId,
        sessionId: session.id,
        productId: w.productId,
        mode: "REPLACE",
        countedQty: 90,
        expectedQty: 100,
        unitCostOverride: 5,
        countedById: w.userId,
      },
    });
    const sale = await openSale(w, 30); // stock 70, uncommitted

    const commit = inTenant(A, w, () =>
      A.inventory.commitStockCountSession(session.id, {}, { sub: w.userId }),
    );
    const waited = await sawLockWait(sale.pid);
    await sale.commit();
    await commit;

    const p = await productOf(w);
    const moves = await movementsOf(w);
    const cost = moves.find((m) => m.type === "COST_BASIS")!;
    const adj = moves.find((m) => m.type === "ADJUSTMENT")!;
    console.log(
      `SA-767(b3) observed: lockWait=${waited} stock=${p.currentStock} avg=${p.averageCost} ` +
        `costStockAfter=${cost.stockAfter} adjDelta=${adj.quantity} adjStockAfter=${adj.stockAfter}`,
    );
    expect(waited).toBe(true);
    expect(Number(p.currentStock)).toBe(90);
    expect(Number(cost.stockAfter)).toBe(70); // the stock the cost row was written at
    expect(Number(adj.quantity)).toBe(20);
    expect(Number(adj.stockAfter)).toBe(90);
    expect(Number(adj.avgCostAfter)).toBe(5); // the corrected cost
    const lot = await A.prisma.stockLot.findFirstOrThrow({ where: { tenantId: w.tenantId } });
    expect(Number(lot.unitCost)).toBe(5);
  }, 60_000);

  it("(c) setCostBasis racing a sale stamps the locked stock: stockAfter 70, not the stale 100", async () => {
    const w = await seedWorld("c", 100, 2);
    const sale = await openSale(w, 30); // stock 70, uncommitted

    const setCost = inTenant(A, w, () =>
      A.inventory.setCostBasis(w.productId, { unitCost: 5 }, w.userId),
    );
    const waited = await sawLockWait(sale.pid);
    await sale.commit();
    await setCost;

    const p = await productOf(w);
    const [m] = await movementsOf(w);
    console.log(
      `SA-767(c) observed: lockWait=${waited} stock=${p.currentStock} avg=${p.averageCost} ` +
        `movement=${m.type} stockAfter=${m.stockAfter} avgCostAfter=${m.avgCostAfter}`,
    );
    expect(waited).toBe(true);
    expect(Number(p.currentStock)).toBe(70);
    expect(Number(p.averageCost)).toBe(5);
    expect(Number(m.stockAfter)).toBe(70); // the old code stamped the stale 100
    expect(Number(m.avgCostAfter)).toBe(5);
  }, 60_000);

  it("(c-bulk) bulkSetCostBasis locks every product in one statement and stamps each locked stock", async () => {
    const w = await seedWorld("cbulk", 100, 2);
    const other = await addProduct(w, 40, 1);
    const sale = await openSale(w, 30); // p1 -> 70, uncommitted

    const bulk = inTenant(A, w, () =>
      A.inventory.bulkSetCostBasis(
        {
          items: [
            { productId: other.id, unitCost: 7 },
            { productId: w.productId, unitCost: 5 },
          ],
        } as any,
        w.userId,
      ),
    );
    const waited = await sawLockWait(sale.pid);
    await sale.commit();
    await bulk;

    const moves = await movementsOf(w);
    const stockAfter = (productId: string) =>
      Number(moves.find((m) => m.productId === productId)!.stockAfter);
    expect(waited).toBe(true);
    expect(stockAfter(w.productId)).toBe(70);
    expect(stockAfter(other.id)).toBe(40);
    expect(Number((await productOf(w)).averageCost)).toBe(5);
  }, 60_000);

  /** A durable session with one REPLACE line per `[productId, counted, expected, costOverride?]`. */
  async function seedSession(
    w: World,
    lines: Array<[string, number, number, number?]>,
  ): Promise<string> {
    const session = await A.prisma.stockCountSession.create({
      data: { tenantId: w.tenantId, startedById: w.userId, name: "sa767-e" },
    });
    for (const [productId, counted, expected, cost] of lines) {
      // eslint-disable-next-line no-await-in-loop
      await A.prisma.stockCountLine.create({
        data: {
          tenantId: w.tenantId,
          sessionId: session.id,
          productId,
          mode: "REPLACE",
          countedQty: counted,
          expectedQty: expected,
          unitCostOverride: cost ?? null,
          countedById: w.userId,
        },
      });
    }
    return session.id;
  }

  const commitSession = (s: Services, w: World, sessionId: string) =>
    inTenant(s, w, () => s.inventory.commitStockCountSession(sessionId, {}, { sub: w.userId }));

  it("(e1) one all-zero-delta session committed twice concurrently applies ONCE (session CAS)", async () => {
    const w = await seedWorld("e1", 100, 2);
    // counted == current stock (delta 0) with a cost correction: the case the movement-reference
    // idempotency check cannot see, because COST_BASIS rows carry no reference.
    const sessionId = await seedSession(w, [[w.productId, 100, 100, 5]]);
    const gateA = holdFirstTxOpen(A);

    const first = commitSession(A, w, sessionId);
    await gateA.parked; // A applied the cost row and flipped the session, uncommitted
    // B's pre-tx read still sees the session OPEN (A has not committed).
    const second = commitSession(B, w, sessionId);
    const waited = await sawLockWait(gateA.holderPid);
    gateA.release();
    const [r1, r2] = await Promise.all([first, second]);

    const moves = await movementsOf(w);
    const costRows = moves.filter((m) => m.type === "COST_BASIS");
    const p = await productOf(w);
    console.log(
      `SA-767(e1) observed: lockWait=${waited} costRows=${costRows.length} moves=${moves.length} ` +
        `stock=${p.currentStock} second.alreadyCommitted=${(r2 as any).alreadyCommitted}`,
    );
    expect(waited).toBe(true);
    expect((r1 as any).alreadyCommitted).toBeUndefined();
    expect((r2 as any).alreadyCommitted).toBe(true);
    expect(costRows).toHaveLength(1); // the old code re-ran the COST_BASIS row: 2
    expect(moves.filter((m) => m.type === "ADJUSTMENT")).toHaveLength(0);
    expect(Number(p.currentStock)).toBe(100);
    const s = await A.prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.status).toBe("COMMITTED");
  }, 60_000);

  it("(e1b) a duplicate commit that read the session before the first landed does not erase a later sale", async () => {
    const w = await seedWorld("e1b", 100, 2);
    const sessionId = await seedSession(w, [[w.productId, 100, 100, 5]]);

    // B's pre-tx read sees the session OPEN; B is then parked right before it enters its tx.
    let enterB!: () => void;
    const bMayEnter = new Promise<void>((r) => {
      enterB = r;
    });
    let bPreReadDone!: () => void;
    const bParked = new Promise<void>((r) => {
      bPreReadDone = r;
    });
    const originalB = B.prisma.tenantTransaction.bind(B.prisma) as any;
    jest.spyOn(B.prisma, "tenantTransaction").mockImplementation((async (fn: any, opts?: any) => {
      bPreReadDone();
      await bMayEnter;
      return originalB(fn, opts);
    }) as any);
    const second = commitSession(B, w, sessionId);
    await bParked;

    // The first commit lands completely (no delta), then a sale of 30 commits: stock 70.
    await commitSession(A, w, sessionId);
    const sale = await openSale(w, 30);
    await sale.commit();

    enterB(); // the duplicate now runs against stock 70
    const r2 = await second;

    const p = await productOf(w);
    const moves = await movementsOf(w);
    console.log(
      `SA-767(e1b) observed: stock=${p.currentStock} alreadyCommitted=${(r2 as any).alreadyCommitted} ` +
        `moves=${moves.map((m) => `${m.type}:${m.quantity}`).join(" ")}`,
    );
    expect((r2 as any).alreadyCommitted).toBe(true);
    expect(Number(p.currentStock)).toBe(70); // the old code REPLACEd 70 -> 100, erasing the sale
    expect(moves.filter((m) => m.type === "ADJUSTMENT")).toHaveLength(0);
    expect(moves.filter((m) => m.type === "COST_BASIS")).toHaveLength(1);
  }, 60_000);

  it("(e2) a line saved after the pre-tx read is committed with the session, never dropped", async () => {
    const w = await seedWorld("e2", 100, 2);
    const other = await addProduct(w, 50, 1);
    const sessionId = await seedSession(w, [[w.productId, 90, 100]]);

    // The line for `other` lands AFTER commitStockCountSession's pre-tx read and BEFORE its tx.
    const original = A.prisma.tenantTransaction.bind(A.prisma) as any;
    let injected = false;
    jest.spyOn(A.prisma, "tenantTransaction").mockImplementation((async (fn: any, opts?: any) => {
      if (!injected) {
        injected = true;
        await A.prisma.stockCountLine.create({
          data: {
            tenantId: w.tenantId,
            sessionId,
            productId: other.id,
            mode: "REPLACE",
            countedQty: 45,
            expectedQty: 50,
            countedById: w.userId,
          },
        });
      }
      return original(fn, opts);
    }) as any);

    await commitSession(A, w, sessionId);

    const s = await A.prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    const otherNow = await A.prisma.product.findUniqueOrThrow({ where: { id: other.id } });
    const moves = await movementsOf(w);
    console.log(
      `SA-767(e2) observed: status=${s.status} otherStock=${otherNow.currentStock} ` +
        `adjustments=${moves.filter((m) => m.type === "ADJUSTMENT").length}`,
    );
    expect(injected).toBe(true);
    expect(s.status).toBe("COMMITTED");
    // the old code flipped the session to COMMITTED but left `other` at 50 (the line silently dropped)
    expect(Number(otherNow.currentStock)).toBe(45);
    expect(Number((await productOf(w)).currentStock)).toBe(90);
    expect(moves.filter((m) => m.type === "ADJUSTMENT")).toHaveLength(2);
  }, 60_000);
});
