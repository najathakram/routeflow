/**
 * T4 BT-9 (B334) on a REAL Postgres: a Migration Hub confirm where one staged product collides on a unique
 * key (the tenant's sku). The earlier and later rows stay live, the colliding row is SKIPPED `commit-failed`,
 * and the job reaches CONFIRMED with an undo deadline (so undo works). Every tenant is a throwaway `qa-bt9mig-*`.
 * ProductsService is a thin stub that writes through the real Prisma client, so the constraint error is the
 * database's own.
 */
import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductsService } from "../products/products.service";
import { ExternalRefService } from "./external-ref.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { MigrationService } from "./migration.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("MigrationService BT-9, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: MigrationService;
  let tenantId = "";
  const slug = assertTestTenant(
    `qa-bt9mig-${randomUUID().slice(0, 8)}`,
    "migration.service.bt9.db.spec.ts",
  );

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const tenant = await prisma.tenant.create({ data: { slug, name: `BT9 ${slug}` } });
    tenantId = tenant.id;
    const productsStub = {
      create: (dto: { name: string; sku?: string; unit: string; pricePerUnit: string }) =>
        prisma.product.create({
          data: {
            tenantId,
            name: dto.name,
            sku: dto.sku,
            unit: dto.unit,
            pricePerUnit: dto.pricePerUnit,
          },
        }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MigrationService,
        ExternalRefService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: productsStub },
        { provide: DuplicateMatchService, useValue: { findInvoiceDuplicate: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MigrationService);
  });

  afterAll(async () => {
    if (tenantId) {
      await prisma.importExternalRef.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.migrationStagingRecord
        .deleteMany({ where: { tenantId } })
        .catch(() => undefined);
      await prisma.migrationJob.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.product.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  it("REG-B334 a colliding row is SKIPPED, the rest stay live, the job is CONFIRMED and undoable", async () => {
    await tenantCtx.run(tenantId, async () => {
      const job = await service.createJob({ source: "ZOHO" });
      await service.stageRecords(job.id, [
        {
          entityType: "PRODUCT",
          externalId: "e1",
          payload: { name: "Cola", sku: "S-1", price: "1,234.56" },
        },
        { entityType: "PRODUCT", externalId: "e2", payload: { name: "Cola Twin", sku: "S-1" } },
        {
          entityType: "PRODUCT",
          externalId: "e3",
          payload: { name: "Chips", sku: "S-3", price: "2" },
        },
      ]);

      const res = await service.confirmJob(job.id);
      expect(res.committed).toBe(2);
      expect(res.skipped).toBe(1);

      const after = await prisma.migrationJob.findUnique({ where: { id: job.id } });
      expect(after?.status).toBe("CONFIRMED");
      expect(after?.undoDeadline).toBeInstanceOf(Date);

      const records = await prisma.migrationStagingRecord.findMany({ where: { jobId: job.id } });
      const byExt = Object.fromEntries(records.map((r) => [r.externalId, r]));
      expect(byExt.e1.status).toBe("COMMITTED");
      expect(byExt.e2.status).toBe("SKIPPED");
      expect(byExt.e2.flags).toEqual(["commit-failed"]);
      expect(byExt.e3.status).toBe("COMMITTED");

      const cola = await prisma.product.findFirst({ where: { tenantId, sku: "S-1" } });
      expect(cola?.pricePerUnit.toString()).toBe("1234.56");

      await service.undoJob(job.id);
      expect(await prisma.product.count({ where: { tenantId, sku: { in: ["S-1", "S-3"] } } })).toBe(
        0,
      );
    });
  }, 30_000);

  // Re-running a file already imported is idempotent. Stage recognises the first run's external refs, so the second
  // job has nothing to commit and still confirms; nothing is created twice and the job is never left STAGED.
  it("a re-import of an already-imported file CONFIRMS and creates nothing twice", async () => {
    await tenantCtx.run(tenantId, async () => {
      const rows = [
        {
          entityType: "PRODUCT" as const,
          externalId: "re1",
          payload: { name: "Reimp A", sku: "RE-1" },
        },
        {
          entityType: "PRODUCT" as const,
          externalId: "re2",
          payload: { name: "Reimp B", sku: "RE-2" },
        },
      ];
      const first = await service.createJob({ source: "ZOHO" });
      await service.stageRecords(first.id, rows);
      expect((await service.confirmJob(first.id)).committed).toBe(2);

      const second = await service.createJob({ source: "ZOHO" });
      await service.stageRecords(second.id, rows);
      const res = await service.confirmJob(second.id);
      expect(res.committed).toBe(0);
      const after = await prisma.migrationJob.findUnique({ where: { id: second.id } });
      expect(after?.status).toBe("CONFIRMED");
      expect(
        await prisma.product.count({ where: { tenantId, sku: { in: ["RE-1", "RE-2"] } } }),
      ).toBe(2);

      await service.undoJob(first.id);
    });
  }, 30_000);

  // The same products re-sent under new external ids (a fresh export) reach the database and hit the sku unique key:
  // every row is a P2002 duplicate, nothing commits, and the job must still CONFIRM with the duplicates skipped.
  it("an all-duplicate job (same skus, new external ids) CONFIRMS with 0 committed and every row skipped", async () => {
    await tenantCtx.run(tenantId, async () => {
      const first = await service.createJob({ source: "ZOHO" });
      await service.stageRecords(first.id, [
        { entityType: "PRODUCT", externalId: "dup-a1", payload: { name: "Dup A", sku: "DUP-1" } },
        { entityType: "PRODUCT", externalId: "dup-a2", payload: { name: "Dup B", sku: "DUP-2" } },
      ]);
      expect((await service.confirmJob(first.id)).committed).toBe(2);

      const second = await service.createJob({ source: "ZOHO" });
      await service.stageRecords(second.id, [
        { entityType: "PRODUCT", externalId: "dup-b1", payload: { name: "Dup A2", sku: "DUP-1" } },
        { entityType: "PRODUCT", externalId: "dup-b2", payload: { name: "Dup B2", sku: "DUP-2" } },
      ]);
      const res = await service.confirmJob(second.id);
      expect(res).toMatchObject({ committed: 0, skipped: 2 });
      const after = await prisma.migrationJob.findUnique({ where: { id: second.id } });
      expect(after?.status).toBe("CONFIRMED");

      await service.undoJob(first.id);
    });
  }, 30_000);
});
