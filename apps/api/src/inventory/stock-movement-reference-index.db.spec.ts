/**
 * Row 354 (fix B). Real Postgres, migrations applied. The stock-count idempotency read looks movements up by
 * `reference` under the tenant predicate the isolation extension adds, so `StockMovement` carries a
 * ("tenantId", "reference") index, and that lookup uses it.
 *
 *  (I1) the index exists with that exact column order (red before the migration: no such index).
 *  (I2) the planner uses it for `tenantId = ? AND reference = ?` (the shape the scoped client issues).
 */
import { describeDb } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

describeDb("row 354 - StockMovement(tenantId, reference) index", () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
  }, 60_000);
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("(I1) the index exists, tenantId first, then reference", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'StockMovement' AND indexname = 'StockMovement_tenantId_reference_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/\("tenantId", reference\)/);
  });

  it("(I2) the tenant-scoped reference lookup is plannable on it", async () => {
    // The planner may legitimately prefer the older single-column "StockMovement_tenantId_idx" (tied or cheaper once
    // other specs have filled the table and ANALYZE has run), so the choice between the two is not what this proves.
    // It proves the composite index can serve the lookup: drop the single-column one inside a transaction that is
    // always rolled back (DDL is transactional in Postgres), with seq scans off, and read the plan.
    const ROLLBACK = new Error("rollback after reading the plan");
    let plan: Array<Record<string, string>> = [];
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        await tx.$executeRawUnsafe('DROP INDEX "StockMovement_tenantId_idx"');
        plan = await tx.$queryRawUnsafe<Array<Record<string, string>>>(
          `EXPLAIN SELECT id FROM "StockMovement" WHERE "tenantId" = 'qa-plan-354' AND reference = 'STOCK_COUNT-x'`,
        );
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).toContain("StockMovement_tenantId_reference_idx");
  });
});
