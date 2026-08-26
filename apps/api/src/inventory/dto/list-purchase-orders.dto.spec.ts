import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ListPurchaseOrdersDto } from "./list-purchase-orders.dto";

/**
 * Query params arrive as strings; the global ValidationPipe uses
 * transform:true, so we mimic that with plainToInstance before validating.
 */
function toDto(query: Record<string, string>): ListPurchaseOrdersDto {
  return plainToInstance(ListPurchaseOrdersDto, query);
}

function validateQuery(query: Record<string, string>): string[] {
  return validateSync(toDto(query)).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe("ListPurchaseOrdersDto", () => {
  // Regression: prod 2026-08-25 — GET /inventory/purchase-orders?limit=20 hit
  // Prisma with take: "20" (string) and 500'd with PrismaClientValidationError,
  // because the endpoint had no DTO and no @Type(() => Number) coercion.
  it("coerces page/limit query strings to integers", () => {
    const dto = toDto({ page: "2", limit: "20" });
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(20);
    expect(validateSync(dto)).toEqual([]);
  });

  it("defaults page=1 / limit=20 when omitted", () => {
    const dto = toDto({});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(validateSync(dto)).toEqual([]);
  });

  it("accepts the full web filter set (status, supplierId, from, to)", () => {
    expect(
      validateQuery({
        status: "SENT",
        supplierId: "d0a2e7a4-0000-4000-8000-000000000001",
        from: "2026-08-01",
        to: "2026-08-25",
        page: "1",
        limit: "50",
      }),
    ).toEqual([]);
  });

  it("rejects non-numeric and out-of-range page/limit", () => {
    expect(validateQuery({ limit: "abc" })).toContain("isInt");
    expect(validateQuery({ limit: "0" })).toContain("min");
    expect(validateQuery({ page: "0" })).toContain("min");
  });

  it("rejects a status outside PurchaseOrderStatus", () => {
    // e.g. the stale "PARTIALLY_RECEIVED" mobile still sends — previously a
    // Prisma 500, now a clean 400.
    expect(validateQuery({ status: "PARTIALLY_RECEIVED" })).toContain("isEnum");
  });
});
