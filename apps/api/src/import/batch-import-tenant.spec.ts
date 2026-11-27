/**
 * B1420 (SA-1503): the batch invoice import must refuse a caller with no tenant and must load every
 * queue row by (id, tenantId). R1-R4 of the ruling; R5 is the pin in batch-import-tenant.pin.spec.ts.
 *
 * `forTenant()` returns the UNSCOPED client when there is no tenant context (a SUPER_ADMIN that is not
 * acting as a tenant), so before the fix a tenantless caller read another tenant's scan-queue item,
 * attached any tenant's product id and posted a vendor bill with a NULL tenant.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { BatchImportService } from "./batch-import.service";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

/** Counts every jest.fn call on the mock's model surface and its transaction doors (not getTenantId). */
function prismaCalls(prisma: any): number {
  const seen = new Set<unknown>();
  let n = 0;
  const walk = (o: any, depth: number) => {
    if (!o || seen.has(o) || depth > 2) return;
    seen.add(o);
    for (const key of Object.keys(o)) {
      if (key === "getTenantId") continue;
      const v = o[key];
      if (jest.isMockFunction(v)) n += v.mock.calls.length;
      else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(prisma, 0);
  walk(prisma.forTenant(), 0);
  return n;
}

describe("B1420 BatchImportService tenant isolation", () => {
  let service: BatchImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let vendorBills: { create: jest.Mock; receive: jest.Mock; saveProductMapping: jest.Mock };

  // A fake table: findUnique({id}) is the OLD unscoped read; findFirst({id, tenantId}) is the scoped one.
  const batches: Record<string, { id: string; tenantId: string }> = {
    "batch-a": { id: "batch-a", tenantId: TENANT_A },
    "batch-b": { id: "batch-b", tenantId: TENANT_B },
  };
  const items: Record<string, any> = {
    "item-a": {
      id: "item-a",
      tenantId: TENANT_A,
      batchId: "batch-a",
      status: "NEEDS_REVIEW",
      supplierMatchId: null,
      extractedPayload: { items: [{ extractedName: "Widget", matchedProductId: null }] },
    },
    "item-b": {
      id: "item-b",
      tenantId: TENANT_B,
      batchId: "batch-b",
      status: "NEEDS_REVIEW",
      supplierMatchId: null,
      extractedPayload: { items: [{ extractedName: "Gadget", matchedProductId: null }] },
    },
  };
  const products: Record<string, { id: string; name: string; tenantId: string }> = {
    "prod-a": { id: "prod-a", name: "A Widget", tenantId: TENANT_A },
    "prod-b": { id: "prod-b", name: "B Gadget", tenantId: TENANT_B },
  };
  const scoped = (table: Record<string, any>) => async (args: any) => {
    const row = table[args.where.id];
    if (!row) return null;
    return args.where.tenantId && args.where.tenantId !== row.tenantId ? null : row;
  };
  const unscoped = (table: Record<string, any>) => async (args: any) =>
    table[args.where.id] ?? null;

  beforeEach(async () => {
    prisma = createMockPrisma();
    vendorBills = {
      create: jest.fn().mockResolvedValue({ id: "bill1" }),
      receive: jest.fn().mockResolvedValue({}),
      saveProductMapping: jest.fn().mockResolvedValue({}),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        BatchImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: vendorBills },
        {
          provide: DuplicateMatchService,
          useValue: { findVendorBillDuplicate: jest.fn(), findInvoiceDuplicate: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(BatchImportService);

    prisma.importBatch.findUnique.mockImplementation(unscoped(batches));
    prisma.importBatch.findFirst.mockImplementation(scoped(batches));
    prisma.importBatch.update.mockResolvedValue({ id: "x", status: "READY" });
    prisma.importQueueItem.findUnique.mockImplementation(unscoped(items));
    prisma.importQueueItem.findFirst.mockImplementation(scoped(items));
    prisma.importQueueItem.findMany.mockImplementation(async (args: any) =>
      Object.values(items).filter(
        (i) => i.batchId === args.where.batchId && (!args.where.status || i.status === "CLEAN"),
      ),
    );
    prisma.importQueueItem.groupBy.mockResolvedValue([]);
    prisma.importQueueItem.update.mockImplementation((args: any) =>
      Promise.resolve({ ...items[args.where.id], ...args.data }),
    );
    prisma.product.findMany.mockImplementation(async (args: any) =>
      Object.values(products).filter(
        (p) =>
          args.where.id.in.includes(p.id) &&
          (!args.where.tenantId || args.where.tenantId === p.tenantId),
      ),
    );
    prisma.supplier.findMany.mockResolvedValue([]);
  });

  describe("R1 a caller with no tenant gets the coded 403 and touches nothing", () => {
    beforeEach(() => prisma.getTenantId.mockReturnValue(null));

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["getBatch", () => service.getBatch("batch-b")],
      ["updateItemLines", () => service.updateItemLines("item-b", { lines: [] } as any)],
      ["resolveItem", () => service.resolveItem("item-b")],
      ["postBatch", () => service.postBatch("batch-b", "user-1")],
    ];

    it.each(calls)("%s -> 403 TENANT_CONTEXT_REQUIRED with 0 prisma calls", async (_name, call) => {
      const err: any = await call().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
      // C3: "0 prisma calls" means 0 query calls; the helper reads the tenant exactly once.
      expect(prismaCalls(prisma)).toBe(0);
      expect(prisma.getTenantId).toHaveBeenCalledTimes(1);
    });
  });

  it("R2 postBatch with no tenant writes no vendor bill (today: one per CLEAN item)", async () => {
    prisma.getTenantId.mockReturnValue(null);
    items["item-b"].status = "CLEAN";
    try {
      await service.postBatch("batch-b", "user-1").catch(() => undefined);
      expect(vendorBills.create).toHaveBeenCalledTimes(0);
      expect(vendorBills.receive).toHaveBeenCalledTimes(0);
    } finally {
      items["item-b"].status = "NEEDS_REVIEW";
    }
  });

  describe("R3 another tenant's id is a 404 with the same body as a random id, scoped to the caller", () => {
    const rejection = async (p: Promise<unknown>) => {
      const err: any = await p.then(
        () => null,
        (e) => e,
      );
      return err;
    };

    it.each([
      ["getBatch", (id: string) => service.getBatch(id), "batch-b", "batch-nope", "importBatch"],
      [
        "updateItemLines",
        (id: string) => service.updateItemLines(id, { lines: [] } as any),
        "item-b",
        "item-nope",
        "importQueueItem",
      ],
      [
        "resolveItem",
        (id: string) => service.resolveItem(id),
        "item-b",
        "item-nope",
        "importQueueItem",
      ],
      [
        "postBatch",
        (id: string) => service.postBatch(id, "user-1"),
        "batch-b",
        "batch-nope",
        "importBatch",
      ],
    ] as const)("%s", async (_name, call, foreignId, randomId, model) => {
      prisma.getTenantId.mockReturnValue(TENANT_A);
      const foreign = await rejection(call(foreignId));
      expect(foreign).toBeInstanceOf(NotFoundException);
      // The where clause carries the caller's tenant, never the id alone.
      const where = (prisma as any)[model].findFirst.mock.calls[0]?.[0]?.where;
      expect(where).toMatchObject({ id: foreignId, tenantId: TENANT_A });
      (prisma as any)[model].findFirst.mockClear();
      const random = await rejection(call(randomId));
      expect(random).toBeInstanceOf(NotFoundException);
      expect(foreign.getResponse()).toEqual(random.getResponse());
      // The foreign tenant's CLEAN rows were never read or written.
      expect(prisma.importQueueItem.update).not.toHaveBeenCalled();
      expect(vendorBills.create).not.toHaveBeenCalled();
    });
  });

  describe("R4 a product id from another tenant is refused with a 400 that names it", () => {
    it("updateItemLines: the stored payload is unchanged", async () => {
      prisma.getTenantId.mockReturnValue(TENANT_A);
      const err: any = await service
        .updateItemLines("item-a", { lines: [{ index: 0, productId: "prod-b" }] } as any)
        .then(
          () => null,
          (e) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(String(err.message)).toContain("prod-b");
      expect(prisma.importQueueItem.update).not.toHaveBeenCalled();
      expect(vendorBills.saveProductMapping).not.toHaveBeenCalled();
      // The product lookup was scoped to the caller's tenant.
      expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT_A });
    });

    it("an own product id still maps", async () => {
      prisma.getTenantId.mockReturnValue(TENANT_A);
      await service.updateItemLines("item-a", {
        lines: [{ index: 0, productId: "prod-a" }],
      } as any);
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ extractedPayload: expect.anything() }),
        }),
      );
    });
  });

  describe("R6 listBatches and createBatch with no tenant move from 400 to the coded 403", () => {
    beforeEach(() => prisma.getTenantId.mockReturnValue(null));

    it("listBatches", async () => {
      const err: any = await service.listBatches().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
    });

    it("createBatch", async () => {
      const err: any = await service.createBatch({}).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
    });
  });
});
