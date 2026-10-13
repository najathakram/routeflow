/**
 * H1 / M1 unit pins for product delete (the real-Postgres proof is products-bulk-delete-keeps-history.db.spec.ts):
 *
 *   - "active" is the ORDER's status, read through the relation (an OrderItem.status never advances), in the single
 *     and the bulk path alike;
 *   - the hard-delete step never writes an order, invoice or stock row, and runs INSIDE one transaction after the
 *     product rows are locked and the product is re-classified;
 *   - a Restrict or unique violation is a coded 409, never an uncoded 500.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { ProductsService } from "./products.service";
import {
  activeOrderItemWhere,
  mapProductDeleteError,
  planProductDelete,
  TERMINAL_ORDER_STATUSES,
} from "./product-delete-classify";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

const OPEN_ORDER = { status: { notIn: ["DELIVERED", "CANCELLED"] } };

describe("activeOrderItemWhere: the guard is keyed on the order, not on the line", () => {
  it("one id: the order's status is not in the terminal set, and the line's own status is never read", () => {
    expect(TERMINAL_ORDER_STATUSES).toEqual(["DELIVERED", "CANCELLED"]);
    expect(activeOrderItemWhere("p1")).toEqual({ productId: "p1", order: OPEN_ORDER });
    expect(activeOrderItemWhere("p1")).not.toHaveProperty("status");
  });

  it("many ids: an `in` list with the same order filter", () => {
    expect(activeOrderItemWhere(["p1", "p2"])).toEqual({
      productId: { in: ["p1", "p2"] },
      order: OPEN_ORDER,
    });
  });
});

describe("mapProductDeleteError", () => {
  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "test" });

  it.each(["P2002", "P2003"])("%s becomes a coded 409 PRODUCT_DELETE_CONFLICT", (code) => {
    const mapped = mapProductDeleteError(known(code));
    expect(mapped).toBeInstanceOf(ConflictException);
    expect((mapped as ConflictException).getResponse()).toMatchObject({
      code: "PRODUCT_DELETE_CONFLICT",
    });
  });

  it("any other error is returned untouched", () => {
    const other = known("P2025");
    expect(mapProductDeleteError(other)).toBe(other);
    const plain = new Error("x");
    expect(mapProductDeleteError(plain)).toBe(plain);
  });
});

describe("planProductDelete", () => {
  /** A db whose every table answers `groupBy` from a per-table list of referenced product ids. */
  function fakeDb(opts: { open?: string[]; referenced?: Record<string, string[]> }) {
    const table = (ids: string[], isOrderItem = false) => ({
      groupBy: jest.fn(async (args: any) => {
        // The first orderItem probe is the "open order" one (it carries the relation filter).
        if (isOrderItem && args.where.order) {
          return (opts.open ?? []).map((productId) => ({ productId }));
        }
        return ids.map((productId) => ({ productId }));
      }),
    });
    const tables = [
      "invoiceItem",
      "stockMovement",
      "vendorBillItem",
      "purchaseOrderItem",
      "estimateItem",
      "returnItem",
      "recurringInvoiceItem",
      "orderTemplateItem",
      "deliveryMutation",
      "stockLot",
    ];
    const db: Record<string, any> = {
      orderItem: table(opts.referenced?.orderItem ?? [], true),
      recipe: { groupBy: jest.fn(async () => []) },
      recipeComponent: { groupBy: jest.fn(async () => []) },
      product: { findMany: jest.fn(async () => []) },
    };
    for (const t of tables) db[t] = table(opts.referenced?.[t] ?? []);
    return db;
  }

  it("a line on an open order is skipped with the code; a delivered-only reference is soft; a bare product is hard", async () => {
    const db = fakeDb({ open: ["open"], referenced: { orderItem: ["open", "done"] } });
    const plan = await planProductDelete(
      db,
      "t1",
      ["open", "done", "bare"],
      new Map([["open", "Open One"]]),
    );

    expect(plan.skipped).toEqual([
      {
        id: "open",
        code: "PRODUCT_HAS_ACTIVE_ORDER_ITEMS",
        reason: "Open One has active order items and cannot be deleted",
      },
    ]);
    expect(plan.softIds).toEqual(["done"]);
    expect(plan.hardIds).toEqual(["bare"]);
    // The very first probe is the relation-keyed one.
    expect(db.orderItem.groupBy.mock.calls[0][0].where).toEqual(
      activeOrderItemWhere(["open", "done", "bare"]),
    );
  });

  it("any record that names a product makes it soft, whichever table holds it", async () => {
    const db = fakeDb({ referenced: { stockMovement: ["a"], returnItem: ["b"] } });
    const plan = await planProductDelete(db, "t1", ["a", "b", "c"], new Map());
    expect(plan.softIds).toEqual(["a", "b"]);
    expect(plan.hardIds).toEqual(["c"]);
  });
});

describe("ProductsService delete: history is never written", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let raw: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    raw = jest.fn().mockResolvedValue([]);
    (prisma as any).getTenantId = jest.fn().mockReturnValue("t1");
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
    // The tx the delete runs in: the same models, plus a recording raw-SQL tag (the row lock).
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: raw }),
    );
    prisma.product.findMany.mockImplementation(async (args: any) =>
      args?.where?.id?.in ? args.where.id.in.map((id: string) => ({ id, name: id })) : [],
    );
  });

  it("remove(): a line on a still-open order refuses with the coded 400, asked through the order's status", async () => {
    prisma.product.findUnique.mockResolvedValue({ id: "p1", name: "P1", isActive: true } as any);
    prisma.orderItem.count.mockResolvedValue(1);

    const err = await service.remove("p1").catch((e: unknown) => e);

    expect(prisma.orderItem.count).toHaveBeenCalledWith({
      where: { productId: "p1", order: OPEN_ORDER },
    });
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      code: "PRODUCT_HAS_ACTIVE_ORDER_ITEMS",
      message: "Cannot delete product with active order items",
    });
  });

  it("bulkDelete: a reference-free product is removed without any order, invoice or stock row being written", async () => {
    const result = await service.bulkDelete(["p1"]);

    expect(result).toEqual({ deleted: 1, softDeleted: 0, skipped: [] });
    for (const history of [
      prisma.orderItem,
      prisma.invoiceItem,
      prisma.stockMovement,
      prisma.vendorBillItem,
      prisma.purchaseOrderItem,
      prisma.estimateItem,
      prisma.returnItem,
      prisma.orderTemplateItem,
      prisma.deliveryMutation,
      prisma.stockLot,
    ]) {
      expect(history.deleteMany).not.toHaveBeenCalled();
    }
    expect(prisma.product.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["p1"] } } });
  });

  it("bulkDelete: the product rows are locked and the product re-classified INSIDE the transaction, before the delete", async () => {
    const order: string[] = [];
    raw.mockImplementation(async () => {
      order.push("lock");
      return [];
    });
    prisma.orderItem.groupBy.mockImplementation(async () => {
      order.push(prisma.tenantTransaction.mock.calls.length > 0 ? "classify-in-tx" : "classify");
      return [];
    });
    prisma.product.deleteMany.mockImplementation(async () => {
      order.push("delete");
      return { count: 1 };
    });

    await service.bulkDelete(["p1"]);

    const firstLock = order.indexOf("lock");
    const lastClassify = order.lastIndexOf("classify-in-tx");
    expect(firstLock).toBeGreaterThan(-1);
    expect(lastClassify).toBeGreaterThan(firstLock);
    expect(order.indexOf("delete")).toBeGreaterThan(lastClassify);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("bulkDelete: a Restrict foreign-key violation that fires after the lock is a coded 409, not a 500", async () => {
    prisma.product.deleteMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" }),
    );

    const err = await service.bulkDelete(["p1"]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "PRODUCT_DELETE_CONFLICT",
    });
  });

  it("bulkDelete: an unrelated failure still surfaces as itself", async () => {
    const boom = new Error("connection reset");
    prisma.product.deleteMany.mockRejectedValue(boom);
    await expect(service.bulkDelete(["p1"])).rejects.toBe(boom);
  });
});

describe("source pins: no delete step writes history", () => {
  const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it.each(["products.service.ts", "product-delete-classify.ts"])(
    "%s never deleteMany's an order, invoice or stock table",
    (file) => {
      const src = code(read(file));
      for (const model of ["orderItem", "invoiceItem", "stockMovement", "stockLot"]) {
        expect(src).not.toMatch(new RegExp(`${model}\\s*\\.deleteMany`));
      }
    },
  );
});
