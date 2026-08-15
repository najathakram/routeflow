/**
 * Security tests for the products module.
 *
 * F9-009: DELETE /products/bulk bound an inline unvalidated { ids: string[] }.
 * A caller could post an unbounded (or non-string) array driving a huge cascade
 * delete. BulkDeleteProductsDto now caps the batch and enforces element types.
 *
 * F8-003: the bulk product-import handler echoed raw Prisma/exception text in
 * its per-row `errors[].reason` (DB schema disclosure). It now returns a generic
 * "Import failed" and logs the real error server-side.
 */
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { BulkDeleteProductsDto } from "./dto/bulk-delete-products.dto";

describe("BulkDeleteProductsDto — F9-009 input validation", () => {
  it("rejects an array over the 500-id cap", async () => {
    const dto = plainToInstance(BulkDeleteProductsDto, {
      ids: Array.from({ length: 501 }, (_, i) => `p${i}`),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ids")).toBe(true);
  });

  it("rejects an empty array", async () => {
    const dto = plainToInstance(BulkDeleteProductsDto, { ids: [] });
    expect((await validate(dto)).some((e) => e.property === "ids")).toBe(true);
  });

  it("rejects non-string ids", async () => {
    const dto = plainToInstance(BulkDeleteProductsDto, { ids: [1, 2, 3] });
    expect((await validate(dto)).some((e) => e.property === "ids")).toBe(true);
  });

  it("accepts a bounded array of string ids", async () => {
    const dto = plainToInstance(BulkDeleteProductsDto, { ids: ["p1", "p2"] });
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe("ProductsService — F8-003 import error disclosure", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: AddonService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  it("returns a generic per-row reason instead of the raw Prisma error", async () => {
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    prisma.product.create.mockRejectedValue(
      new Error('column "secret_internal_col" of relation "Product" does not exist'),
    );

    const result = await service.importFromZoho({
      items: [{ name: "Widget", unit: "ea", pricePerUnit: 1 }],
    } as any);

    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("Import failed");
    // The DB internals must not reach the client...
    expect(result.errors[0].reason).not.toMatch(/relation|column|secret_internal_col/i);
    // ...but the real error IS logged server-side.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("secret_internal_col"));
  });
});

/**
 * clearAll() used to run `TRUNCATE TABLE "Product" CASCADE`. TRUNCATE accepts no
 * WHERE clause and is not subject to row-level security, so one tenant's OPERATOR
 * calling DELETE /products/clear-all wiped every tenant's catalog, orders, invoices
 * and inventory — and the tenant-scoped count in the response hid the damage.
 */
describe("ProductsService.clearAll — cross-tenant wipe regression", () => {
  let service: ProductsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.$executeRaw = jest.fn();
    prisma.$transaction = jest.fn().mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: AddonService, useValue: {} },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  it("never issues a raw TRUNCATE", async () => {
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);

    await service.clearAll();

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    const raw = JSON.stringify(prisma.$executeRaw.mock.calls);
    expect(raw).not.toMatch(/TRUNCATE/i);
  });

  it("selects the products to remove through the tenant-scoped client", async () => {
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "p1" }]);

    await service.clearAll();

    // forTenant() is what injects the tenantId filter — reading the ids through it
    // is what bounds the blast radius to the caller's own tenant.
    expect(prisma.forTenant).toHaveBeenCalled();
    expect(prisma.forTenant().product.findMany).toHaveBeenCalledWith({ select: { id: true } });
  });

  it("reports only the caller's own product count", async () => {
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);

    await expect(service.clearAll()).resolves.toEqual({ deleted: 2 });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("is a no-op when the tenant has no products", async () => {
    prisma.forTenant().product.findMany.mockResolvedValue([]);

    await expect(service.clearAll()).resolves.toEqual({ deleted: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
