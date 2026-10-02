import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * SA-587e (#2717 M2): assignToVariants is a Serializable transaction; even with the family-first
 * lock order a plain 40001/P2034 can still abort it, so the WHOLE attempt runs inside
 * retryOnTxConflict. Stock alerts fire once, after the successful attempt, never per attempt.
 */
const D = (n: number) => new Prisma.Decimal(n);
const parent = {
  id: "parent-1",
  name: "Cola 24pk",
  unit: "case",
  parentProductId: null,
  currentStock: D(20),
  averageCost: D(4),
  standardCost: null,
  costingMethod: "AVCO",
  unitsPerBox: 12,
  category: "Beverages",
  isTobacco: false,
};
const variant = {
  id: "variant-1",
  name: "Cola - Cherry",
  variantName: "Cherry",
  parentProductId: "parent-1",
  currentStock: D(0),
  averageCost: null,
  costingMethod: "AVCO",
};
const dto = {
  parentProductId: "parent-1",
  assignments: [{ productId: "variant-1", qty: 5 }],
} as any;

describe("assignToVariants retry (SA-587e)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let alerts: jest.SpyInstance;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.product.findUnique.mockResolvedValue(parent);
    prisma.product.findFirst.mockResolvedValue(variant);
    const mod = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = mod.get(InventoryService);
    alerts = jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
  });

  /** First attempt runs the whole body (ids pushed, writes made) then aborts with `err`. */
  function failFirstAttemptWith(err: unknown) {
    const real = prisma.tenantTransaction.getMockImplementation()!;
    let n = 0;
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
      n += 1;
      const out = await real(fn, opts);
      if (n === 1) throw err;
      return out;
    });
  }

  it("placement: assignToVariants runs its transaction inside retryOnTxConflict", () => {
    const src = fs.readFileSync(path.join(__dirname, "inventory.service.ts"), "utf8");
    const body = src.slice(src.indexOf("async assignToVariants("));
    const head = body.slice(0, body.indexOf("// ─── Stock count"));
    expect(head).toMatch(/retryOnTxConflict\(\s*["'`]inventory\.assignToVariants/);
  });

  it("retries a P2034 conflict, fires alerts once with the successful attempt's ids only", async () => {
    failFirstAttemptWith(Object.assign(new Error("conflict"), { code: "P2034" }));
    const result = await service.assignToVariants(dto, "user-1");
    expect(result.parentRemaining).toBe(15);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveBeenCalledWith(["variant-1"]);
  });

  it("retries a raw 40001 the same way", async () => {
    failFirstAttemptWith(Object.assign(new Error("ssi"), { code: "40001" }));
    await service.assignToVariants(dto, "user-1");
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveBeenCalledWith(["variant-1"]);
  });

  it("does not retry a non-conflict error and fires no alerts", async () => {
    failFirstAttemptWith(new BadRequestException("nope"));
    await expect(service.assignToVariants(dto, "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(alerts).not.toHaveBeenCalled();
  });
});
