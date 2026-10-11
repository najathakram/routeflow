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
 *  (b1) commitStockCount (legacy client session) landing AFTER a sale replaces the post-sale stock
 *       (counted 90, delta 90 - 70).
 *  (b2) a sale landing AFTER a count is not erased (regression guard, the old code was already right).
 *  (b3) commitStockCountSession after a sale: cost row and adjustment come from the locked rows; the
 *       REPLACE delta is counted - the line's expectedQty (90 - 100), so the sale survives (60).
 *  (c)  setCostBasis racing a sale stamps the locked stock (stockAfter 70), not the stale read.
 *  (c-bulk) bulkSetCostBasis locks every product in one statement and stamps each locked stock.
 *  (d)  recordAdjustment racing a purchase takes avgCostAfter and the lot cost from the locked row.
 *  SA-767 L-2.2 - the batched count committer (50-line batches under one advisory lock):
 *  (r1) 120 counted products, a sale mid-commit: the commit holds <= 50 Product rows at a time (the
 *       old single tx held all 120), a sale of a counted product waits one batch, a sale of a product
 *       in a later batch does not wait at all, and the final stock is counted - the sale.
 *  (r2) a commit killed after batch 1 (injected failure): batch-1 lines applied once, the re-run
 *       finishes the rest, one movement per product, the session ends COMMITTED once.
 *  (r3) two concurrent commits: exactly one wins, the other is 409 STOCK_COUNT_COMMITTING.
 *  (r4) line save / remove and discard are refused 409 STOCK_COUNT_COMMITTING once movements exist and
 *       the session is not COMMITTED; nothing changes.
 *  (r5) an all-zero-delta session committed twice applies once (regression guard, not a red), and a
 *       line added before the commit starts is included.
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
  hold(holderPid = 0): Promise<void> {
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

  it("(b3) a durable-session commit after a sale: the line's delta (counted 90 - expected 100) lands on the post-sale stock, cost row + adjustment from the locked rows", async () => {
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
    // SA-767 r-note 2 correction: REPLACE is counted - expectedQty (90 - 100 = -10), NOT counted - the
    // locked stock; the sale of 30 that landed after the count survives: 100 - 30 - 10 = 60.
    expect(Number(p.currentStock)).toBe(60);
    expect(Number(cost.stockAfter)).toBe(70); // the stock the cost row was written at
    expect(Number(adj.quantity)).toBe(-10);
    expect(Number(adj.stockAfter)).toBe(60);
    expect(Number(adj.avgCostAfter)).toBe(5); // the corrected cost
    expect(await A.prisma.stockLot.count({ where: { tenantId: w.tenantId } })).toBe(0); // no +delta, no lot
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

  // ─── SA-767 L-2.2: the batched count committer (r1-r5) ──────────────────────────────────────────

  /** Settles to the value, or to "pending" if it has not settled within `ms` (never hangs a case). */
  const settleWithin = <T>(p: Promise<T>, ms: number) =>
    Promise.race([
      p.then(
        (value) => ({ value }) as { value: T; err?: undefined },
        (err) => ({ err }) as { value?: undefined; err: any },
      ),
      sleep(ms).then(() => "pending" as const),
    ]);

  const pad3 = (i: number) => String(i).padStart(3, "0");
  interface CountWorld extends World {
    sessionId: string;
    idOf: (i: number) => string;
  }

  /** `n` products at `stock`, one session with one REPLACE line each (counted `counted`, expected `stock`). */
  async function seedCountWorld(
    label: string,
    n: number,
    opts: { stock?: number; counted?: (i: number) => number } = {},
  ): Promise<CountWorld> {
    const stock = opts.stock ?? 100;
    const base = await seedWorld(label, stock, 2);
    await A.prisma.product.delete({ where: { id: base.productId } });
    const idOf = (i: number) => `${base.tenantId.slice(0, 8)}-${label}-${pad3(i)}`;
    await A.prisma.product.createMany({
      data: Array.from({ length: n }, (_, k) => ({
        id: idOf(k + 1),
        name: `Widget ${label} ${pad3(k + 1)}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        averageCost: 2,
        costingMethod: "AVCO" as const,
        tenantId: base.tenantId,
      })),
    });
    const session = await A.prisma.stockCountSession.create({
      data: { tenantId: base.tenantId, startedById: base.userId, name: `sa767 ${label}` },
    });
    await A.prisma.stockCountLine.createMany({
      data: Array.from({ length: n }, (_, k) => ({
        tenantId: base.tenantId,
        sessionId: session.id,
        productId: idOf(k + 1),
        mode: "REPLACE" as const,
        countedQty: (opts.counted ?? (() => stock - 10))(k + 1),
        expectedQty: stock,
        countedById: base.userId,
      })),
    });
    return { ...base, productId: idOf(1), sessionId: session.id, idOf };
  }

  const stockOfId = async (id: string) =>
    Number((await A.prisma.product.findUniqueOrThrow({ where: { id } })).currentStock);
  const commitSession = (s: Services, w: CountWorld) =>
    inTenant(s, w, () => s.inventory.commitStockCountSession(w.sessionId, {}, { sub: w.userId }));
  const sessionOf = (w: CountWorld) =>
    A.prisma.stockCountSession.findUniqueOrThrow({ where: { id: w.sessionId } });
  const countMovements = (w: CountWorld) =>
    A.prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, reference: `STOCK_COUNT-${w.sessionId}` },
    });

  /** Product rows of the tenant NO transaction currently holds a row lock on. */
  async function unlockedProducts(tenantId: string): Promise<number> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM
           (SELECT id FROM "Product" WHERE "tenantId" = $1 FOR UPDATE SKIP LOCKED) t`,
        [tenantId],
      );
      return rows[0].n as number;
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  /**
   * Parks the FIRST `tenantTransaction` of `svc` that locks `productId` (seen on its Product lock
   * statement): `inside` holds it open after its body ran (locks still held), `after` holds the
   * caller AFTER that tx committed (no row locks, the commit still unfinished).
   */
  function parkTxLocking(svc: Services, productId: string) {
    const inside = new Gate();
    const after = new Gate();
    gates.push(inside, after);
    const original = svc.prisma.tenantTransaction.bind(svc.prisma) as any;
    let done = false;
    jest.spyOn(svc.prisma, "tenantTransaction").mockImplementation((async (fn: any, opts?: any) => {
      if (done) return original(fn, opts);
      let touched = false;
      const result = await original(
        async (tx: any) => {
          const spyTx = new Proxy(tx, {
            get(target, prop) {
              const v = Reflect.get(target, prop, target);
              if (prop === "$executeRaw" && typeof v === "function") {
                return (s: unknown, ...vals: unknown[]) => {
                  if (vals.some((x) => Array.isArray(x) && x.includes(productId))) touched = true;
                  return v.call(target, s, ...vals);
                };
              }
              return typeof v === "function" ? v.bind(target) : v;
            },
          });
          const out = await fn(spyTx);
          if (touched && !done) {
            const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            await inside.hold(pid);
          }
          return out;
        },
        { ...opts, timeout: 40_000, maxWait: 15_000 },
      );
      if (touched && !done) {
        done = true;
        await after.hold(0);
      }
      return result;
    }) as any);
    return { inside, after };
  }

  it("(r1) a sale mid-commit waits at most one batch: 120 counted products, the lock window is <= 50 rows", async () => {
    const w = await seedCountWorld("r1", 120);
    const p70 = w.idOf(70);
    const p110 = w.idOf(110);
    const park = parkTxLocking(A, p70);

    let commitSettled = false;
    const commit = commitSession(A, w).finally(() => {
      commitSettled = true;
    });
    commit.catch(() => undefined);
    const parked = await Promise.race([
      park.inside.parked.then(() => true),
      sleep(20_000).then(() => false),
    ]);
    expect(parked).toBe(true);

    // The window: how many Product rows the in-flight commit holds. The old single tx held all 120.
    const held = 120 - (await unlockedProducts(w.tenantId));
    // A sale of #70 (inside the held batch) waits on the commit, a sale of #110 (a later batch) does not.
    const saleOn70 = (async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query('SELECT id FROM "Product" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE', [
          p70,
          w.tenantId,
        ]);
        const { rows } = await c.query(
          'UPDATE "Product" SET "currentStock" = "currentStock" - 30 WHERE id = $1 RETURNING "currentStock"',
          [p70],
        );
        await c.query("COMMIT");
        return Number(rows[0].currentStock);
      } finally {
        c.release();
      }
    })();
    saleOn70.catch(() => undefined);
    const waitedOn70 = await sawLockWait(park.inside.holderPid);
    const saleOn110 = (async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query('SELECT id FROM "Product" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE', [
          p110,
          w.tenantId,
        ]);
        await c.query('UPDATE "Product" SET "currentStock" = "currentStock" - 30 WHERE id = $1', [
          p110,
        ]);
        await c.query("COMMIT");
        return true;
      } finally {
        c.release();
      }
    })();
    saleOn110.catch(() => undefined);
    const sale110 = await settleWithin(saleOn110, 3_000);
    console.log(
      `SA-767(r1) observed: parked=${parked} rowsHeld=${held} saleOn70Waited=${waitedOn70} ` +
        `saleOn110=${sale110 === "pending" ? "BLOCKED" : "done"}`,
    );

    park.inside.release(); // the batch with #70 commits; the sale of #70 then proceeds
    const left70 = await saleOn70;
    // the batch is done and the commit is parked BEFORE its later batches / CAS: the sale already landed
    const afterParked = await Promise.race([
      park.after.parked.then(() => true),
      sleep(20_000).then(() => false),
    ]);
    const settledWhileParked = commitSettled;
    const stock70WhileParked = await stockOfId(p70);
    park.after.release();
    await commit;

    expect(held).toBeLessThanOrEqual(50); // old code: 120
    expect(waitedOn70).toBe(true); // the sale really waited, behind this batch's row lock
    expect(sale110).not.toBe("pending"); // a product in a later batch is free while a batch is in flight
    expect(afterParked).toBe(true);
    expect(settledWhileParked).toBe(false); // the sale finished while the commit still had work left
    expect(left70).toBe(60); // 100 - 10 (the batch) - 30 (the sale)
    expect(stock70WhileParked).toBe(60);
    // final: the count's delta is counted - expectedQty = -10 for everyone; the two sales survive
    expect(await stockOfId(p70)).toBe(60);
    expect(await stockOfId(p110)).toBe(60);
    expect(await stockOfId(w.idOf(1))).toBe(90);
    expect(await stockOfId(w.idOf(120))).toBe(90);
    const moves = await countMovements(w);
    expect(moves).toHaveLength(120);
    expect(moves.every((m) => Number(m.quantity) === -10)).toBe(true);
    const mv70 = moves.find((m) => m.productId === p70)!;
    expect(Number(mv70.stockAfter)).toBe(90); // the batch landed first (100 - 10); the sale then left 60
    const s = await sessionOf(w);
    expect(s.status).toBe("COMMITTED");
    expect(s.committedAt).not.toBeNull();
    expect(s.movementReference).toBe(`STOCK_COUNT-${w.sessionId}`);
  }, 120_000);

  it("(r2) a commit killed after batch 1 resumes: batch-1 lines are applied once, the session ends COMMITTED once", async () => {
    // New-behaviour pin: the old single-tx committer has no batch boundary to be killed at (its first
    // commit simply succeeds), so this is red on the old code only as "the commit did not fail".
    const w = await seedCountWorld("r2", 120);
    const original = A.prisma.tenantTransaction.bind(A.prisma) as any;
    let calls = 0;
    jest.spyOn(A.prisma, "tenantTransaction").mockImplementation(((fn: any, opts?: any) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("injected: process killed before batch 2"));
      return original(fn, opts);
    }) as any);

    const first = await settleWithin(commitSession(A, w), 30_000);
    jest.restoreAllMocks();

    const midMoves = await countMovements(w);
    const midSession = await sessionOf(w);
    console.log(
      `SA-767(r2) observed: first=${first === "pending" ? "pending" : first.err ? "failed" : "succeeded"} ` +
        `movementsAfterKill=${midMoves.length} status=${midSession.status}`,
    );
    expect(first).not.toBe("pending");
    expect((first as any).err?.message).toMatch(/injected/);
    expect(midMoves).toHaveLength(50); // batch 1 only
    expect(midSession.status).toBe("OPEN"); // still not COMMITTED
    expect(midSession.committedAt).toBeNull();

    const resumed: any = await commitSession(A, w);

    expect(resumed.applied).toBe(120); // 50 resumed + 70 new: the session's complete movement set
    const moves = await countMovements(w);
    expect(moves).toHaveLength(120);
    expect(new Set(moves.map((m) => m.productId)).size).toBe(120); // one movement per product
    for (const i of [1, 50, 51, 120]) expect(await stockOfId(w.idOf(i))).toBe(90); // -10 once, not -20
    const s = await sessionOf(w);
    expect(s.status).toBe("COMMITTED");
    expect(s.committedAt).not.toBeNull();

    // a further commit is the already-committed outcome and writes nothing
    const again: any = await commitSession(A, w);
    expect(again.alreadyCommitted).toBe(true);
    expect(await countMovements(w)).toHaveLength(120);
  }, 180_000);

  it("(r3) two concurrent commits: exactly one wins, the other gets 409 STOCK_COUNT_COMMITTING", async () => {
    const w = await seedCountWorld("r3", 3);
    const gateA = holdFirstTxOpen(A); // A's first batch ran and is parked; A still owns the session lock

    const first = commitSession(A, w);
    first.catch(() => undefined);
    await gateA.parked;
    // B's pre-checks see the session OPEN (A has not committed).
    const second = await settleWithin(commitSession(B, w), 8_000);
    console.log(
      `SA-767(r3) observed: second=${second === "pending" ? "BLOCKED" : second.err ? `err ${JSON.stringify(second.err?.response)}` : "returned"}`,
    );
    gateA.release();
    const winner: any = await first;

    expect(second).not.toBe("pending");
    expect((second as any).err?.status).toBe(409);
    expect((second as any).err?.response).toMatchObject({ code: "STOCK_COUNT_COMMITTING" });
    expect(winner.applied).toBe(3);
    const moves = await countMovements(w);
    expect(moves).toHaveLength(3);
    expect((await sessionOf(w)).status).toBe("COMMITTED");
    for (let i = 1; i <= 3; i++) expect(await stockOfId(w.idOf(i))).toBe(90);
  }, 90_000);

  it("(r4) line edits and discard are refused 409 STOCK_COUNT_COMMITTING once movements exist and the session is not COMMITTED", async () => {
    const w = await seedCountWorld("r4", 3);
    const upsertBefore = await A.prisma.stockCountLine.findFirstOrThrow({
      where: { sessionId: w.sessionId, productId: w.idOf(1) },
    });
    // The "committing" state: a batch landed its movement for this session's reference, no CAS yet.
    await A.prisma.stockMovement.create({
      data: {
        tenantId: w.tenantId,
        productId: w.idOf(1),
        type: "ADJUSTMENT",
        quantity: -10,
        stockAfter: 90,
        reference: `STOCK_COUNT-${w.sessionId}`,
        performedById: w.userId,
      },
    });

    const attempts = {
      upsert: await inTenant(A, w, () =>
        A.inventory.upsertStockCountLine(
          w.sessionId,
          { productId: w.idOf(2), countedQty: 1 } as any,
          { sub: w.userId },
        ),
      ).catch((e) => e),
      remove: await inTenant(A, w, () =>
        A.inventory.removeStockCountLine(w.sessionId, w.idOf(3)),
      ).catch((e) => e),
      discard: await inTenant(A, w, () => A.inventory.discardStockCountSession(w.sessionId)).catch(
        (e) => e,
      ),
    };
    console.log(
      `SA-767(r4) observed: ${Object.entries(attempts)
        .map(
          ([k, v]: [string, any]) =>
            `${k}=${v?.response?.code ?? (v?.status ? v.status : "ALLOWED")}`,
        )
        .join(" ")}`,
    );
    for (const [name, err] of Object.entries(attempts) as Array<[string, any]>) {
      expect({ name, status: err?.status }).toEqual({ name, status: 409 });
      expect(err.response).toMatchObject({ code: "STOCK_COUNT_COMMITTING" });
    }
    // nothing changed
    const s = await sessionOf(w);
    expect(s.status).toBe("OPEN");
    expect(await A.prisma.stockCountLine.count({ where: { sessionId: w.sessionId } })).toBe(3);
    const upsertAfter = await A.prisma.stockCountLine.findFirstOrThrow({
      where: { sessionId: w.sessionId, productId: w.idOf(1) },
    });
    expect(Number(upsertAfter.countedQty)).toBe(Number(upsertBefore.countedQty));
  }, 60_000);

  it("(r5) an all-zero-delta session committed twice applies once; a line added before the commit is included", async () => {
    // Regression guard (not a red): the old committer was already correct for the sequential case.
    const w = await seedCountWorld("r5", 2, { counted: () => 100 }); // counted == expected: delta 0
    // a line added through the real autosave path before the commit starts: counted 95 of 100
    const extra = await A.prisma.product.create({
      data: {
        id: w.idOf(3),
        name: "Widget r5 003",
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 100,
        averageCost: 2,
        costingMethod: "AVCO",
        tenantId: w.tenantId,
      },
    });
    await inTenant(A, w, () =>
      A.inventory.upsertStockCountLine(
        w.sessionId,
        { productId: extra.id, countedQty: 95 } as any,
        {
          sub: w.userId,
        },
      ),
    );

    const first: any = await commitSession(A, w);
    const mid = await sessionOf(w);
    const second: any = await commitSession(B, w);
    const end = await sessionOf(w);

    expect(first.applied).toBe(1); // only the +/- line writes a movement; the two zero lines are skipped
    expect(first.skipped).toBe(2);
    expect(await stockOfId(extra.id)).toBe(95);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.applied).toBe(0);
    expect(await countMovements(w)).toHaveLength(1);
    expect(mid.status).toBe("COMMITTED");
    expect(end.committedAt!.getTime()).toBe(mid.committedAt!.getTime()); // flipped once
  }, 60_000);
});
