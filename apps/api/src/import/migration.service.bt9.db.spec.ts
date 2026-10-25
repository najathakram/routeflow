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
});
