/**
 * B1420 (SA-1503) on a real Postgres: the batch invoice import refuses a caller with no tenant and
 * never reads or writes across tenants. Every tenant is a throwaway `qa-b1420-*` slug; every row is
 * dummy data under an `acme` name.
 *
 *  - R2 end to end: a tenantless caller posting another tenant's CLEAN queue item writes NO vendor
 *    bill with a NULL tenantId (before the fix the bill was created with tenantId NULL).
 *  - R3 against the real database: tenant A cannot see, edit, resolve or post tenant B's batch or item.
 *
 * VendorBillsService is replaced by a stand-in whose `create` performs the same tenantless-capable
 * write the real one does (vendor-bills.service.ts: `tenantTransaction` -> `tx.vendorBill.create`
 * with no tenantId in `data`), because the real service needs seven unrelated collaborators.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { BatchImportService } from "./batch-import.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const INVOICE_NO = `B1420-${RUN_SUFFIX}`;
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b1420-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "batch-import-tenant.db.spec.ts",
  );
}

describeDb("B1420 batch import tenant isolation: real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: BatchImportService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const standInVendorBills = {
      scanInvoice: jest.fn(),
      saveProductMapping: jest.fn().mockResolvedValue({}),
      receive: jest.fn().mockResolvedValue({}),
      create: async (dto: any) =>
        prisma.tenantTransaction(async (tx: any) =>
          tx.vendorBill.create({
            data: {
              billNumber: `BILL-B1420-${randomUUID().slice(0, 8)}`,
              status: "DRAFT",
              totalOwed: dto.totalOwed ?? 0,
              supplierInvoiceNumber: dto.supplierInvoiceNumber,
              notes: dto.notes,
            },
          }),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: standInVendorBills },
        {
          provide: DuplicateMatchService,
          useValue: { findVendorBillDuplicate: jest.fn(), findInvoiceDuplicate: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(BatchImportService);
  });

  afterAll(async () => {
    // Bills written by a tenantless run carry no tenantId, so they are found by their invoice number.
    await prisma?.vendorBillItem
      .deleteMany({ where: { vendorBill: { supplierInvoiceNumber: INVOICE_NO } } })
      .catch(() => undefined);
    await prisma?.vendorBill
      .deleteMany({ where: { supplierInvoiceNumber: INVOICE_NO } })
      .catch(() => undefined);
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.importQueueItem.deleteMany({ where: { tenantId } });
        await prisma.importBatch.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string): Promise<{ id: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1420 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return { id: tenant.id };
  }

  async function seedQueue(tenantId: string, label: string) {
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Acme ${label} Widget`,
        sku: `B1420-${RUN_SUFFIX}-${label}`,
        unit: "unit",
        pricePerUnit: 5,
      },
    });
    const batch = await prisma.importBatch.create({
      data: { tenantId, kind: "BATCH_BILLS", status: "READY", totalFiles: 1, cleanCount: 1 },
    });
    const item = await prisma.importQueueItem.create({
      data: {
        tenantId,
        batchId: batch.id,
        status: "CLEAN",
        invoiceNumber: INVOICE_NO,
        total: "10.00",
        extractedPayload: {
          items: [
            {
              extractedName: `Acme ${label} Widget`,
              matchedProductId: product.id,
              qty: 2,
              unitCost: 5,
              confidence: "high",
            },
          ],
        },
      },
    });
    return { product, batch, item };
  }

  const nullTenantBills = () =>
    prisma.vendorBill.count({ where: { tenantId: null, supplierInvoiceNumber: INVOICE_NO } });

  it("R2: a tenantless caller posting another tenant's CLEAN item is refused and writes no NULL-tenant bill", async () => {
    const tenantB = await seedTenant("b-post");
    const b = await seedQueue(tenantB.id, "b-post");
    expect(await nullTenantBills()).toBe(0);

    const err: any = await tenantCtx
      .run(null, () => service.postBatch(b.batch.id, "user-1"), "SUPER_ADMIN")
      .then(
        () => null,
        (e) => e,
      );

    expect(await nullTenantBills()).toBe(0);
    expect(err?.getStatus?.()).toBe(403);
    expect(err?.getResponse?.()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
    const after = await prisma.importQueueItem.findUnique({ where: { id: b.item.id } });
    expect(after?.status).toBe("CLEAN");
    expect(after?.vendorBillId).toBeNull();
  }, 30_000);

  it("R1: a tenantless caller cannot read or edit another tenant's batch or item", async () => {
    const tenantB = await seedTenant("b-read");
    const b = await seedQueue(tenantB.id, "b-read");
    const run = (fn: () => Promise<unknown>) =>
      tenantCtx.run(null, fn, "SUPER_ADMIN").then(
        () => null,
        (e: any) => e,
      );
    for (const err of [
      await run(() => service.getBatch(b.batch.id)),
      await run(() => service.updateItemLines(b.item.id, { lines: [] } as any)),
      await run(() => service.resolveItem(b.item.id)),
    ]) {
      expect((err as any)?.getResponse?.()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
    }
  }, 30_000);

  it("R3: tenant A gets a 404 (same body as a random id) for tenant B's batch and item, and B's rows are untouched", async () => {
    const tenantA = await seedTenant("a");
    const tenantB = await seedTenant("b");
    const a = await seedQueue(tenantA.id, "a");
    const b = await seedQueue(tenantB.id, "b");
    const asA = <T>(fn: () => Promise<T>) =>
      tenantCtx.run(tenantA.id, fn).then(
        () => null,
        (e: any) => e,
      );
    const randomId = randomUUID();

    const pairs: Array<[string, (id: string) => Promise<unknown>, string]> = [
      ["getBatch", (id) => service.getBatch(id), b.batch.id],
      ["updateItemLines", (id) => service.updateItemLines(id, { lines: [] } as any), b.item.id],
      ["resolveItem", (id) => service.resolveItem(id), b.item.id],
      ["postBatch", (id) => service.postBatch(id, "user-1"), b.batch.id],
    ];
    for (const [, call, foreignId] of pairs) {
      // eslint-disable-next-line no-await-in-loop
      const foreign: any = await asA(() => call(foreignId));
      // eslint-disable-next-line no-await-in-loop
      const random: any = await asA(() => call(randomId));
      expect(foreign?.getStatus?.()).toBe(404);
      expect(foreign?.getResponse()).toEqual(random?.getResponse());
    }

    const bItem = await prisma.importQueueItem.findUnique({ where: { id: b.item.id } });
    expect(bItem?.status).toBe("CLEAN");
    expect(bItem?.vendorBillId).toBeNull();
    expect(await prisma.vendorBill.count({ where: { supplierInvoiceNumber: INVOICE_NO } })).toBe(0);

    // A product of tenant B cannot be attached to tenant A's item.
    const refused: any = await asA(() =>
      service.updateItemLines(a.item.id, {
        lines: [{ index: 0, productId: b.product.id }],
      } as any),
    );
    expect(refused?.getStatus?.()).toBe(400);
    expect(String(refused?.message)).toContain(b.product.id);
    const aItem = await prisma.importQueueItem.findUnique({ where: { id: a.item.id } });
    expect((aItem?.extractedPayload as any).items[0].matchedProductId).toBe(a.product.id);
  }, 60_000);
});
