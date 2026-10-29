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
    // With enable_seqscan off the planner must pick the best index; an index probe on the new one proves it can serve
    // the lookup (the table here is near-empty, where a seq scan would otherwise win on cost).
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<Array<Record<string, string>>>(
        `EXPLAIN SELECT id FROM "StockMovement" WHERE "tenantId" = 'qa-plan-354' AND reference = 'STOCK_COUNT-x'`,
      );
    });
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).toContain("StockMovement_tenantId_reference_idx");
  });
});
