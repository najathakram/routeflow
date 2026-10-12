/**
 * Portal limits, Branch B — DB lane for POST /selling-restrictions/bulk.
 * What a mocked prisma cannot prove: the createMany and the audit row really share ONE Postgres
 * transaction (a failure after the insert leaves 0 rows), the identical-rule skip reads the real
 * rows (a lifted rule no longer counts), a category scope is ONE category row, and another tenant's
 * product or category is never written.
 *
 * Run via `npm run local:test:db`. Every tenant is a throwaway `qa-bulk-<run>-*` slug approved by
 * `assertTestTenant`, and afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const admin = { sub: "u-bulk-op", username: "bulk-operator" } as JwtPayload;
const SPEC = "selling-restrictions-admin.bulk.db.spec.ts";

describeDb("selling-restriction bulk create against real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: SellingRestrictionsAdminService;

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-bulk-${run}-a`, SPEC);
  const slugB = assertTestTenant(`qa-bulk-${run}-b`, SPEC);
  let tenantA: string;
  let tenantB: string;
  let categoryA: string;
  let categoryB: string;
  let productsA: string[];
  let productB: string;

  const asA = <T>(fn: () => Promise<T>) => ctx.run(tenantA, fn);
  const rulesFor = (productIds: string[]) =>
    raw.sellingRestriction.findMany({ where: { productId: { in: productIds } } });
  const bulkAudits = (tenantId: string) =>
    raw.auditLog.findMany({ where: { tenantId, action: "selling_restriction.bulk_created" } });

  async function seedProduct(tenantId: string, name: string) {
    const p = await raw.product.create({
      data: { tenantId, name, unit: "EACH", pricePerUnit: "1.00" },
    });
    return p.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new SellingRestrictionsAdminService(prisma, new AuditService(prisma));
    tenantA = (await raw.tenant.create({ data: { slug: slugA, name: `Bulk spec ${slugA}` } })).id;
    tenantB = (await raw.tenant.create({ data: { slug: slugB, name: `Bulk spec ${slugB}` } })).id;
    categoryA = (await raw.productCategory.create({ data: { tenantId: tenantA, name: "Vapes" } }))
      .id;
    categoryB = (await raw.productCategory.create({ data: { tenantId: tenantB, name: "Vapes" } }))
      .id;
    productsA = [];
    for (let i = 1; i <= 20; i++) productsA.push(await seedProduct(tenantA, `Acme item ${i}`));
    productB = await seedProduct(tenantB, "Other tenant item");
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: t } });
      await raw.product.deleteMany({ where: { tenantId: t } });
      await raw.productCategory.deleteMany({ where: { tenantId: t } });
      await raw.tenant.deleteMany({ where: { id: t } });
    }
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const t of [tenantA, tenantB]) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: t } });
    }
  });

  it("bulk with 12 products creates 12 rows and ONE audit row naming them", async () => {
    const twelve = productsA.slice(0, 12);
    const res = await asA(() =>
      service.bulkCreate({ jurisdiction: "STATE", states: ["Texas"], productIds: twelve }, admin),
    );
    expect(res.created).toBe(12);
    expect(res.skipped).toBe(0);
    const rows = await rulesFor(twelve);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(res.createdIds));
    for (const r of rows) {
      expect(r).toMatchObject({
        tenantId: tenantA,
        categoryId: null,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "BUYER_PORTAL",
        reason: "Portal limit",
        createdById: admin.sub,
        liftedAt: null,
      });
    }
    const audits = await bulkAudits(tenantA);
    expect(audits).toHaveLength(1);
    expect(audits[0].id).toBe(res.auditId);
    expect((audits[0].meta as { ids: string[] }).ids).toEqual(res.createdIds);
  }, 30_000);

  it("a failure after the insert rolls the WHOLE batch back: 0 rows, 0 audit rows", async () => {
    const twelve = productsA.slice(0, 12);
    let seenInsideTx = -1;
    const original = prisma.tenantTransaction.bind(prisma);
    jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((fn: any, opts?: any) =>
      original(async (tx: any) => {
        const failingAudit = new Proxy(tx, {
          get(target, key) {
            if (key !== "auditLog") return target[key];
            return {
              create: async () => {
                // The rows ARE there inside the transaction ...
                seenInsideTx = await target.sellingRestriction.count({
                  where: { productId: { in: twelve } },
                });
                throw new Error("audit insert failed");
              },
            };
          },
        });
        return fn(failingAudit);
      }, opts)) as typeof prisma.tenantTransaction);

    await expect(
      asA(() =>
        service.bulkCreate({ jurisdiction: "STATE", states: ["TX"], productIds: twelve }, admin),
      ),
    ).rejects.toThrow("audit insert failed");
    expect(seenInsideTx).toBe(12);
    // ... and none of them survived the rollback.
    expect(await rulesFor(twelve)).toHaveLength(0);
    expect(await bulkAudits(tenantA)).toHaveLength(0);
  }, 30_000);

  it("an identical live rule is skipped and reported; a lifted one no longer counts", async () => {
    const [p1, p2, p3] = productsA;
    await asA(() =>
      service.bulkCreate(
        { jurisdiction: "STATE", states: ["TX", "OK"], productIds: [p1, p2] },
        admin,
      ),
    );
    const again = await asA(() =>
      service.bulkCreate(
        { jurisdiction: "STATE", states: ["oklahoma", "texas"], productIds: [p1, p2, p3] },
        admin,
      ),
    );
    expect(again).toMatchObject({ created: 1, skipped: 2, skippedProductIds: [p1, p2] });
    expect(await rulesFor([p1])).toHaveLength(1);
    expect(await rulesFor([p3])).toHaveLength(1);

    // A different surface is not identical.
    const legal = await asA(() =>
      service.bulkCreate(
        { jurisdiction: "STATE", states: ["TX", "OK"], surface: "ALL", productIds: [p1] },
        admin,
      ),
    );
    expect(legal.created).toBe(1);

    // Lift p2's portal rule: the next identical request creates it again.
    await raw.sellingRestriction.updateMany({
      where: { productId: p2, surface: "BUYER_PORTAL" },
      data: { liftedAt: new Date(Date.now() - 1000), liftReason: "spec" },
    });
    const afterLift = await asA(() =>
      service.bulkCreate({ jurisdiction: "STATE", states: ["TX", "OK"], productIds: [p2] }, admin),
    );
    expect(afterLift).toMatchObject({ created: 1, skipped: 0 });
  }, 30_000);

  it("a category scope writes ONE category rule", async () => {
    const res = await asA(() =>
      service.bulkCreate({ jurisdiction: "FEDERAL", states: [], categoryId: categoryA }, admin),
    );
    expect(res).toMatchObject({ created: 1, skipped: 0 });
    const rows = await raw.sellingRestriction.findMany({ where: { tenantId: tenantA } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ categoryId: categoryA, productId: null, states: [] });
  }, 30_000);

  it("another tenant's product or category is a 404 and nothing is written in either tenant", async () => {
    await expect(
      asA(() =>
        service.bulkCreate(
          { jurisdiction: "STATE", states: ["TX"], productIds: [productsA[0], productB] },
          admin,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      asA(() =>
        service.bulkCreate({ jurisdiction: "STATE", states: ["TX"], categoryId: categoryB }, admin),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await raw.sellingRestriction.count({ where: { tenantId: { in: [tenantA, tenantB] } } }),
    ).toBe(0);
    expect(await bulkAudits(tenantA)).toHaveLength(0);
  }, 30_000);
});
