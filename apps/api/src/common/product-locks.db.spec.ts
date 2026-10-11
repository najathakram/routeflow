/**
 * SA-767 L-1 (#2841 / B908) — real-Postgres proof of `lockProductsForStock`.
 *
 * (i) DEADLOCK ORDER (B908). A catalog writer holds the FAMILY row F (house order: family first) and
 *     still has to take component C. A stock writer needs [C, R, F] with C's id SORTING BEFORE F's.
 *     - Old locking (sorted id, one lock per id): the stock writer takes C, then blocks on F; the
 *       catalog writer's request for C closes the cycle -> Postgres aborts one side with 40P01
 *       (the characterization test below runs the OLD loop and expects exactly that).
 *     - `lockProductsForStock` ranks FAMILY -> recipe product -> the rest: it blocks on F while
 *       holding NOTHING (asserted with NOWAIT probes on C and R), the catalog writer takes C and
 *       commits, then the stock writer finishes. No 40P01.
 * (ii) OPPOSITE LINE ORDER: two sales (the real `decrementStockForSale`) over the same two products
 *     in opposite line orders, 10 rounds, never deadlock and both land.
 * (iii) TENANT: another tenant's product id in the list is not locked.
 *
 * Throwaway `qa-sa767-<run>-*` tenants (assertTestTenant); only the rows this spec creates are removed.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { decrementStockForSale } from "../orders/order-stock";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { lockProductsForStock } from "./product-locks";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const sqlState = (err: any): string | undefined =>
  err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code;
const isDeadlock = (err: unknown) =>
  err !== undefined &&
  (sqlState(err) === "40P01" || /deadlock/i.test(String((err as any)?.message)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pre-SA-767 `InventoryService.lockProducts`: sorted ids, one lock statement per id. */
async function oldLockProducts(tx: any, tenantId: string, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await tx.$executeRaw`SELECT id FROM "Product" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  }
}

describeDb("SA-767 L-1 — lockProductsForStock (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      /* eslint-disable no-await-in-loop */
      await prisma.stockMovement.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.product.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
      /* eslint-enable no-await-in-loop */
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa767-${run}-${seq}-${label}`, "product-locks.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA-767 ${slug}` } });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  const mkProduct = (
    tenantId: string,
    id: string,
    kind: "STANDARD" | "FAMILY" | "RECIPE",
    stock = 0,
  ) =>
    prisma.product.create({
      data: {
        id,
        tenantId,
        kind,
        name: `Acme ${id}`,
        unit: "ea",
        pricePerUnit: 5,
        currentStock: stock,
      },
    });

  /** Ids chosen so the plain component C sorts BEFORE the recipe product R before the family F. */
  async function seedCatalog() {
    const tenantId = await seedTenant("cat");
    const ids = {
      c: `${run}-a-comp-${seq}`,
      r: `${run}-m-recipe-${seq}`,
      f: `${run}-z-family-${seq}`,
    };
    expect([ids.c, ids.r, ids.f].sort()).toEqual([ids.c, ids.r, ids.f]);
    await mkProduct(tenantId, ids.c, "STANDARD");
    await mkProduct(tenantId, ids.r, "RECIPE");
    await mkProduct(tenantId, ids.f, "FAMILY");
    return { tenantId, ...ids };
  }

  /** Polls until some backend is blocked by `blockerPid`. */
  async function waitUntilBlockedBy(blockerPid: number, timeoutMs = 4_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
        [blockerPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    return false;
  }

  /** True iff a NOWAIT lock on `id` succeeds on a fresh connection (i.e. nobody holds it). */
  async function isFree(id: string): Promise<boolean> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE NOWAIT', [id]);
      return true;
    } catch (e: any) {
      if (e?.code === "55P03") return false;
      throw e;
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  /**
   * The B908 interleave. The catalog writer (raw pg) holds F; the stock writer (a Prisma tx running
   * `lockStock`) is started and must be seen BLOCKED by it; only then does the catalog writer take C
   * and commit. Returns what each side saw.
   */
  async function interleave(
    lockStock: (tx: any, w: Awaited<ReturnType<typeof seedCatalog>>) => Promise<void>,
  ) {
    const w = await seedCatalog();
    const writer = await pool.connect();
    let writerError: unknown;
    let stockError: unknown;
    let blocked = false;
    let stockHoldsC = true;
    let stockHoldsR = true;
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '6s'");
      const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await writer.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [w.f]);

      const stock = prisma
        .$transaction(async (tx) => lockStock(tx, w), { timeout: 15_000, maxWait: 5_000 })
        .catch((e) => {
          stockError = e;
        });
      blocked = await waitUntilBlockedBy(pid);
      stockHoldsC = !(await isFree(w.c));
      stockHoldsR = !(await isFree(w.r));
      try {
        // The catalog writer's next step: the component row (house order: family -> ... -> components).
        await writer.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [w.c]);
        await writer.query("COMMIT");
      } catch (e) {
        writerError = e;
        await writer.query("ROLLBACK").catch(() => undefined);
      }
      await stock;
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    return { blocked, stockHoldsC, stockHoldsR, writerError, stockError };
  }

  it("(i) OLD per-id id-order locking deadlocks against the catalog writer (the B908 cycle)", async () => {
    const r = await interleave((tx, w) => oldLockProducts(tx, w.tenantId, [w.c, w.r, w.f]));
    expect(r.blocked).toBe(true);
    expect(r.stockHoldsC).toBe(true); // it took C, then waited on F: the V -> F edge
    expect(isDeadlock(r.writerError) || isDeadlock(r.stockError)).toBe(true);
  }, 60_000);

  it("(i) lockProductsForStock waits on the FAMILY row holding nothing, so no 40P01", async () => {
    const r = await interleave((tx, w) => lockProductsForStock(tx, w.tenantId, [w.c, w.r, w.f]));
    expect(r.blocked).toBe(true);
    expect(r.stockHoldsC).toBe(false);
    expect(r.stockHoldsR).toBe(false);
    expect(r.writerError).toBeUndefined();
    expect(r.stockError).toBeUndefined();
  }, 60_000);

  it("(ii) two sales over the same two products in opposite line orders never deadlock (10 rounds)", async () => {
    const tenantId = await seedTenant("sales");
    const p1 = `${run}-s1-${seq}`;
    const p2 = `${run}-s2-${seq}`;
    await mkProduct(tenantId, p1, "STANDARD", 1000);
    await mkProduct(tenantId, p2, "STANDARD", 1000);
    const deps = { logger: new Logger("sa767-lock"), tenantId };
    const sale = (lines: string[]) =>
      tenantCtx.run(tenantId, () =>
        prisma.tenantTransaction(
          async (tx: any) => {
            await decrementStockForSale(
              deps,
              tx,
              lines.map((productId) => ({ productId, qty: 1 })),
              true,
              { orderId: randomUUID(), notes: "CREATE", performedById: null },
            );
            await sleep(40); // hold the locks so the two txs genuinely overlap
          },
          { timeout: 15_000 },
        ),
      );
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.allSettled([sale([p1, p2]), sale([p2, p1])]);
      const failures = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      expect(failures.map((f) => String(f.reason))).toEqual([]);
    }
    const rows = await prisma.product.findMany({
      where: { tenantId },
      select: { currentStock: true },
    });
    expect(rows.map((p) => Number(p.currentStock))).toEqual([980, 980]);
  }, 120_000);

  it("(iii) another tenant's product id in the list is not locked; the tenant's own is", async () => {
    const a = await seedTenant("own");
    const b = await seedTenant("other");
    const own = `${run}-own-${seq}`;
    const foreign = `${run}-foreign-${seq}`;
    await mkProduct(a, own, "STANDARD");
    await mkProduct(b, foreign, "STANDARD");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await lockProductsForStock(tx, a, [own, foreign]);
        entered();
        await gate;
      },
      { timeout: 15_000 },
    );
    await inside;
    try {
      expect(await isFree(own)).toBe(false);
      expect(await isFree(foreign)).toBe(true);
    } finally {
      release();
      await holder;
    }
  }, 60_000);

  it("refuses an empty tenant id, and an empty id list issues no statement", async () => {
    const calls: unknown[] = [];
    const tx = { $executeRaw: (...a: unknown[]) => calls.push(a) };
    await expect(lockProductsForStock(tx, "", ["x"])).rejects.toThrow(/tenantId/);
    await expect(lockProductsForStock(tx, null, ["x"])).rejects.toThrow(/tenantId/);
    await lockProductsForStock(tx, "t", []);
    expect(calls).toHaveLength(0);
  });
});
