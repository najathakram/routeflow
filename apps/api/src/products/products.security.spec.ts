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
