/**
 * Row 383 triage (b): bulk tracked-category assign on real Postgres. `assigned` counts MOVERS only (rows already in the
 * category are excluded), `processed` counts every requested row the tenant can see. A product with NO category (a NULL
 * trackedCategoryId, the common case) must be a mover: a `NOT` filter on a nullable column would silently drop NULLs.
 * Throwaway `qa-trkcat-*` tenants (approved by assertTestTenant).
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TrackedCategoriesService } from "./tracked-categories.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("bulk assign products to a tracked category, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: TrackedCategoriesService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];

  async function tenant(label: string) {
    const slug = assertTestTenant(
      `qa-trkcat-${run}-${label}`,
      "tracked-categories-assign.db.spec.ts",
    );
    const t = await raw.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(t.id);
    const cat = (name: string) =>
      raw.trackedCategory.create({
        data: { tenantId: t.id, name: `${name} ${run}`, taxType: "NONE" },
      });
    const product = (name: string, trackedCategoryId?: string) =>
      raw.product.create({
        data: {
          tenantId: t.id,
          name: `${name} ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: "5",
          ...(trackedCategoryId ? { trackedCategoryId } : {}),
        } as never,
      });
    return { tenantId: t.id, cat, product };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 4 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new TrackedCategoriesService(prisma);
  }, 60_000);

  afterAll(async () => {
    await raw.product.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.trackedCategory.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 60_000);

  it("assigned = movers (a NULL category counts), processed = every requested row; an already-assigned row is processed, not moved", async () => {
    const t = await tenant("a");
    const target = await t.cat("Target");
    const other = await t.cat("Other");
    const unassigned = await t.product("unassigned");
    const elsewhere = await t.product("elsewhere", other.id);
    const already = await t.product("already", target.id);

    const out = await ctx.run(t.tenantId, () =>
      service.assignProducts(target.id, [unassigned.id, elsewhere.id, already.id]),
    );

    const rows = await raw.product.findMany({
      where: { id: { in: [unassigned.id, elsewhere.id, already.id] } },
      select: { id: true, trackedCategoryId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.trackedCategoryId]));
    // every requested row ends up in the target category, whichever way it got there
    expect(byId.get(unassigned.id)).toBe(target.id);
    expect(byId.get(elsewhere.id)).toBe(target.id);
    expect(byId.get(already.id)).toBe(target.id);
    expect(out).toEqual({ assigned: 2, processed: 3 });
  });

  it("re-assigning the same products: assigned 0 (nothing moved), processed = all (so a caller can tell 'already in this type')", async () => {
    const t = await tenant("b");
    const target = await t.cat("Target");
    const p1 = await t.product("p1", target.id);
    const p2 = await t.product("p2", target.id);
    const out = await ctx.run(t.tenantId, () => service.assignProducts(target.id, [p1.id, p2.id]));
    expect(out).toEqual({ assigned: 0, processed: 2 });
  });

  it("ids from another tenant are not touched: assigned 0 and processed 0", async () => {
    const a = await tenant("c");
    const b = await tenant("d");
    const target = await a.cat("Target");
    const foreign = await b.product("foreign");
    const out = await ctx.run(a.tenantId, () => service.assignProducts(target.id, [foreign.id]));
    expect(out).toEqual({ assigned: 0, processed: 0 });
    expect(
      (await raw.product.findUniqueOrThrow({ where: { id: foreign.id } })).trackedCategoryId,
    ).toBeNull();
  });
});
