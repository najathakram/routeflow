import fs from "node:fs";
import path from "node:path";
import { UnprocessableEntityException } from "@nestjs/common";
import {
  API_ERROR_CODES,
  LOW_STOCK_DEFAULT,
  isLowStock,
  lowStockThreshold,
  stockLevel,
} from "@routeflow/types";
import {
  LOW_STOCK_DEFAULT as API_LOW_STOCK_DEFAULT,
  LOW_STOCK_ID_CAP,
  LOW_STOCK_TOO_MANY_CODE,
  lowStockIdsQuery,
  lowStockProductIds,
} from "./low-stock-ids";
import { buildProductListWhere, needsLowStockIds } from "./product-list-where";

/** SA-1002 (W-925): the one low-stock rule, its SQL twin pinned to the constant, and the cap that fails loudly. */
describe("stockLevel / isLowStock (the one predicate)", () => {
  it.each([
    [8, 10, true, "LOW"], // above the old 5, within its own point
    [8, null, true, "IN"], // no point: the default 5
    [5, null, true, "LOW"], // the default boundary, inclusive
    [4, 3, true, "IN"], // the point wins over the old 5
    [0, null, true, "LOW"], // an active product at zero is LOW
    [-2, null, true, "LOW"],
    [10, 10, true, "LOW"], // stock == reorderPoint is IN the list
    [1, null, false, "OUT"], // inactive is not for sale
  ])("stock %s, reorderPoint %s, active %s is %s", (stock, point, active, level) => {
    expect(stockLevel(stock, point, active)).toBe(level);
    expect(isLowStock(stock, point, active)).toBe(level === "LOW");
  });

  it("a non-finite stock or a negative reorder point is UNKNOWN, never a made-up level", () => {
    expect(stockLevel(Number.NaN, null, true)).toBe("UNKNOWN");
    expect(stockLevel(3, -1, true)).toBe("UNKNOWN");
    expect(isLowStock(Number.NaN, null, true)).toBe(false);
  });

  it("the threshold is the point, else the default", () => {
    expect(lowStockThreshold(7)).toBe(7);
    expect(lowStockThreshold(0)).toBe(0);
    expect(lowStockThreshold(null)).toBe(LOW_STOCK_DEFAULT);
    expect(lowStockThreshold(undefined)).toBe(LOW_STOCK_DEFAULT);
  });
});

describe("the SQL prefetch is the same rule, pinned to the constant", () => {
  const q = lowStockIdsQuery("tenant-1");
  it("is tagged Prisma.sql with the tenant, the default and the cap as parameters", () => {
    expect(q.values).toEqual(["tenant-1", LOW_STOCK_DEFAULT, LOW_STOCK_ID_CAP + 1]);
    const text = q.text.replace(/\s+/g, " ");
    expect(text).toContain('WHERE "tenantId" = $1');
    expect(text).toContain('AND "isActive" = true');
    expect(text).toContain('"currentStock" <= COALESCE("reorderPoint", $2)');
  });
  it("has no second literal 5 and never uses the Unsafe raw API", () => {
    const src = fs.readFileSync(path.join(__dirname, "low-stock-ids.ts"), "utf8");
    expect(src).not.toMatch(/queryRawUnsafe|executeRawUnsafe/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // the one local declaration (pinned equal to the package below) is the only literal
    expect(code.replace(/export const LOW_STOCK_DEFAULT = 5;/, "")).not.toMatch(/\b5\b/);
  });
});

describe("the cap fails loudly (422), never truncates", () => {
  const prismaWith = (rows: { id: string }[]) =>
    ({
      getTenantId: () => "tenant-1",
      tenantTransaction: async (fn: any) => fn({ $queryRaw: async () => rows }),
    }) as any;

  it("returns the ids when at or under the cap", async () => {
    const rows = Array.from({ length: LOW_STOCK_ID_CAP }, (_, i) => ({ id: `p${i}` }));
    expect(await lowStockProductIds(prismaWith(rows))).toHaveLength(LOW_STOCK_ID_CAP);
  });

  it("throws a 422 with its own code one past the cap", async () => {
    const rows = Array.from({ length: LOW_STOCK_ID_CAP + 1 }, (_, i) => ({ id: `p${i}` }));
    const err: any = await lowStockProductIds(prismaWith(rows)).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LOW_STOCK_TOO_MANY);
  });

  it("needs a tenant context", async () => {
    await expect(
      lowStockProductIds({ getTenantId: () => null, tenantTransaction: jest.fn() } as any),
    ).rejects.toThrow(/tenant/);
  });
});

describe("buildProductListWhere with the prefetch", () => {
  it("LOW folds id in (...) and needs the prefetch", () => {
    const where = buildProductListWhere({ stockStatus: "LOW" } as any, { lowStockIds: ["a", "b"] });
    expect(where.isActive).toBe(true);
    expect(where.AND).toEqual([{ id: { in: ["a", "b"] } }]);
    expect(where.currentStock).toBeUndefined();
    expect(() => buildProductListWhere({ stockStatus: "LOW" } as any)).toThrow(/lowStockIds/);
  });
  it("IN_STOCK is the complement on the same ids", () => {
    const where = buildProductListWhere({ stockStatus: "IN_STOCK" } as any, { lowStockIds: ["a"] });
    expect(where.AND).toEqual([{ id: { notIn: ["a"] } }]);
  });
  it("only LOW and IN_STOCK need the prefetch", () => {
    expect(needsLowStockIds({ stockStatus: "LOW" } as any)).toBe(true);
    expect(needsLowStockIds({ stockStatus: "IN_STOCK" } as any)).toBe(true);
    expect(needsLowStockIds({ stockStatus: "OUT_OF_STOCK" } as any)).toBe(false);
    expect(needsLowStockIds({} as any)).toBe(false);
  });
  it("list, ids and CSV all go through the one helper", () => {
    for (const f of ["products.service.ts", "products-export.service.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(src).toContain("lowStockProductIds(this.prisma)");
    }
    const svc = fs.readFileSync(path.join(__dirname, "products.service.ts"), "utf8");
    expect(svc.match(/lowStockProductIds\(this\.prisma\)/g)).toHaveLength(2);
  });
});

describe("low-stock-ids.ts stays boot-safe", () => {
  it("has no value import from @routeflow/types and its local values equal the package's", () => {
    const src = fs.readFileSync(path.join(__dirname, "low-stock-ids.ts"), "utf8");
    expect(src).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+"@routeflow\/types"/m);
    expect(API_LOW_STOCK_DEFAULT).toBe(LOW_STOCK_DEFAULT);
    expect(LOW_STOCK_TOO_MANY_CODE).toBe(API_ERROR_CODES.LOW_STOCK_TOO_MANY);
  });
});
