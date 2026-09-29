/**
 * SA-584 B1 (#2717 M2 fold) — real-Postgres proof that `assignToVariants` (mode `on`) takes the
 * FAMILY row before any variant row, so it cannot deadlock against a family price edit
 * (house order: family -> recipe product -> variant/component rows).
 *
 * One deterministic interleaving on two connections (the sa218-lock-order.db.spec.ts style):
 *   1. the WRITER (a raw `pg` connection) plays the family price edit: it takes the FAMILY row
 *      FOR UPDATE (`lockFamilyRow`);
 *   2. the SERVICE starts assignToVariants [existing V, new W]; a barrier waits until Postgres
 *      reports it BLOCKED by the writer (`pg_blocking_pids`), so the interleaving is real;
 *   3. only then does the writer take the variant row V FOR UPDATE (what `propagateFamilyPrice`'s
 *      updateMany does next) and commit.
 * Before the fix the service had already written V (holding its row lock) and blocked later on the
 * family (new W -> `familyPricesForNewVariant`): step 3 closes V -> F against F -> V and Postgres
 * aborts one side with 40P01. Fixed: the service blocks on the family while holding nothing, the
 * writer takes V at once, and both finish. The writer only LOCKS (writes nothing), which isolates
 * the lock-ORDER property from Serializable's SSI 40001 (pre-existing, not a deadlock).
 *
 * The lock-edge assert: `blocked` must be true (the service really waited on the writer's family
 * lock) and neither side may report 40P01. WRITTEN, NOT RUN by the fold implementer: F2 owns the
 * DB lane (`npm run local:test:db`). Throwaway `qa-2717-b1-<run>` tenant (assertTestTenant).
 */
import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { Pool } from "pg";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}
const describeErr = (err: unknown): string =>
  err === undefined ? "none" : `${sqlState(err) ?? "?"}: ${String((err as any)?.message ?? err)}`;

describeDb("SA-584 B1 — assignToVariants takes the family row first (no 40P01)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InventoryService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2717-b1-${run}`, "variant-assign-lock-order.db.spec.ts");
  let tenantId = "";
  let userId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("on") },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
    tenantId = (await prisma.tenant.create({ data: { slug, name: `2717 B1 ${slug}` } })).id;
    userId = (
      await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.stockLot.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.stockMovement.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.product
        .deleteMany({ where: { tenantId, parentProductId: { not: null } } })
        .catch(() => undefined);
      await prisma.product.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  /** Polls until some backend is blocked by `blockerPid`; false if `done()` or the deadline comes first. */
  async function waitUntilBlockedBy(blockerPid: number, done: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !done()) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
        [blockerPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  it("assign [existing V, new W] while a family price edit holds F and then wants V: no 40P01, both finish", async () => {
    const family = await prisma.product.create({
      data: {
        tenantId,
        name: `Family ${run}`,
        sku: `FAM-${run}`,
        unit: "case",
        unitsPerBox: 12,
        pricePerUnit: "10.00",
        priceTier2: "9.50",
        priceTier3: "9.00",
        priceTier4: "8.50",
        priceTier5: "8.00",
        currentStock: 20,
        averageCost: 4,
      },
    });
    const existing = await prisma.product.create({
      data: {
        tenantId,
        name: `Family ${run} - Cherry`,
        variantName: "Cherry",
        sku: `VAR-${run}-C`,
        unit: "case",
        unitsPerBox: 12,
        parentProductId: family.id,
        pricePerUnit: "10.00",
        currentStock: 0,
      },
    });

    const writer = await pool.connect();
    let writerError: unknown;
    let serviceError: unknown;
    let blocked = false;
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '15s'");
      const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      // 1. the family price edit's first lock (lockFamilyRow)
      await writer.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [family.id]);

      let settled = false;
      const running = tenantCtx
        .run(tenantId, () =>
          service.assignToVariants(
            {
              parentProductId: family.id,
              assignments: [
                { productId: existing.id, qty: 5 },
                { newVariant: { name: "Grape" }, qty: 5 },
              ],
            } as any,
            userId,
          ),
        )
        .then(
          () => undefined,
          (err) => {
            serviceError = err;
          },
        )
        .finally(() => {
          settled = true;
        });
      // 2. the service must really be waiting on the writer's family lock
      blocked = await waitUntilBlockedBy(pid, () => settled);
      try {
        // 3. propagateFamilyPrice's next lock: the variant rows
        await writer.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [existing.id]);
        await writer.query("COMMIT");
      } catch (err) {
        writerError = err;
        await writer.query("ROLLBACK").catch(() => undefined);
      }
      await running;
    } finally {
      writer.release();
    }

    expect({
      blocked,
      writer: describeErr(writerError),
      service: describeErr(serviceError),
    }).toEqual({ blocked: true, writer: "none", service: "none" });

    const parentAfter = await prisma.product.findUniqueOrThrow({ where: { id: family.id } });
    const variantAfter = await prisma.product.findUniqueOrThrow({ where: { id: existing.id } });
    const created = await prisma.product.findMany({
      where: { tenantId, parentProductId: family.id, variantName: "Grape" },
    });
    expect(Number(parentAfter.currentStock)).toBe(10);
    expect(Number(variantAfter.currentStock)).toBe(5);
    expect(created).toHaveLength(1);
    expect(Number(created[0].currentStock)).toBe(5);
  }, 60_000);
});
