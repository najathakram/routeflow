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
 *  (a) two concurrent recordPurchase: the final average is the TRUE weighted average of both applied
 *      in the serialized order, and the second movement's avgCostAfter derives from the first's.
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
  hold(): Promise<void> {
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
          await gate.hold();
          return result;
        },
        { ...opts, timeout: 30_000, maxWait: 15_000 },
      );
    }) as any);
    return gate;
  }

  /** True once some backend of this database is genuinely WAITING on another backend's lock. */
  async function sawLockWait(withinMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND cardinality(pg_blocking_pids(pid)) > 0`,
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
    const waited = await sawLockWait();
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
});
