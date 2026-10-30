/**
 * Row 430 (SA-958 §3.2) on real Postgres: create, update and toggle each leave their AuditLog row in the SAME transaction as
 * the write, and a failed audit insert rolls the write back (the audit insert is forced to fail inside the transaction).
 *
 * WRITTEN, NOT RUN by the builder: win-test runs it (`npm run local:test:db`). Collected only by `jest.db.config.js`.
 * Throwaway `qa-trkaud-<run>` tenants (assertTestTenant); `afterAll` deletes exactly the tenants this run created.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { auditTrackedCategoryWrite } from "./tracked-category-audit";

// The real helper by default; a test makes ONE call fail (a module-namespace spy would hit the compiled getters).
jest.mock("./tracked-category-audit", () => {
  const actual = jest.requireActual("./tracked-category-audit");
  return { ...actual, auditTrackedCategoryWrite: jest.fn(actual.auditTrackedCategoryWrite) };
});
const failNextAudit = (tenantId: string) =>
  (auditTrackedCategoryWrite as unknown as jest.Mock).mockImplementationOnce(
    async (tx: { auditLog: { create(a: unknown): Promise<unknown> } }) => {
      // An invalid audit row (no action) INSIDE the write's transaction.
      await tx.auditLog.create({ data: { tenantId, entityType: "TrackedCategory" } });
    },
  );

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("tracked category writes are audited in the same transaction, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: TrackedCategoriesService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  async function tenant() {
    seq += 1;
    const slug = assertTestTenant(`qa-trkaud-${run}-${seq}`, "tracked-categories.audit.db.spec.ts");
    const t = await raw.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(t.id);
    return t.id;
  }
  const audits = (tenantId: string, entityId: string) =>
    raw.auditLog.findMany({
      where: { tenantId, entityType: "TrackedCategory", entityId },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 4 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new TrackedCategoriesService(prisma);
  }, 60_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.trackedCategory.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 60_000);

  it("create, update and toggle each write exactly one audit row naming the actor, with before/after", async () => {
    const tenantId = await tenant();
    const actor = { sub: "user-op-1", impersonatedBy: "sa-1" };
    const created = await ctx.run(tenantId, () =>
      service.create({ name: `Tobacco ${run}`, taxType: "NONE" } as never, actor),
    );
    const id = (created as { id: string }).id;
    await ctx.run(tenantId, () => service.update(id, { requiresLicense: true } as never, actor));
    await ctx.run(tenantId, () => service.toggle(id, actor));

    const rows = await audits(tenantId, id);
    expect(rows.map((r) => r.action)).toEqual([
      "tracked-category.created",
      "tracked-category.updated",
      "tracked-category.updated",
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ userId: "user-op-1", impersonatedBy: "sa-1" });
    }
    const [, update, toggle] = rows.map(
      (r) => r.meta as { before: Record<string, unknown>; after: Record<string, unknown> },
    );
    expect([update.before.requiresLicense, update.after.requiresLicense]).toEqual([false, true]);
    expect([toggle.before.active, toggle.after.active]).toEqual([true, false]);
  });

  it("a failed audit insert rolls the write back: no category row survives a create whose audit fails", async () => {
    const tenantId = await tenant();
    const name = `Rolled back ${run}`;
    failNextAudit(tenantId);
    await expect(
      ctx.run(tenantId, () => service.create({ name, taxType: "NONE" } as never, { sub: "u" })),
    ).rejects.toBeDefined();
    expect(await raw.trackedCategory.count({ where: { tenantId, name } })).toBe(0);
    expect(await raw.auditLog.count({ where: { tenantId, entityType: "TrackedCategory" } })).toBe(
      0,
    );
  });

  it("a failed audit insert on update leaves the category exactly as it was", async () => {
    const tenantId = await tenant();
    const cat = await raw.trackedCategory.create({
      data: { tenantId, name: `Stable ${run}`, taxType: "NONE", requiresLicense: false },
    });
    failNextAudit(tenantId);
    await expect(
      ctx.run(tenantId, () =>
        service.update(cat.id, { requiresLicense: true } as never, { sub: "u" }),
      ),
    ).rejects.toBeDefined();
    expect(
      (await raw.trackedCategory.findUniqueOrThrow({ where: { id: cat.id } })).requiresLicense,
    ).toBe(false);
  });
});
