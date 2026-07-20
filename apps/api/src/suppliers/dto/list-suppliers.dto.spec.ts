import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ListSuppliersDto } from "./list-suppliers.dto";

/**
 * Query params arrive as strings; the global ValidationPipe uses
 * transform:true, so we mimic that with plainToInstance before validating.
 */
function validateQuery(query: Record<string, string>): string[] {
  const dto = plainToInstance(ListSuppliersDto, query);
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe("ListSuppliersDto.limit", () => {
  // Regression: the web Suppliers page sends limit=0 (fetch-all — the service
  // maps it to a capped fetchAll) and the F9-era @Min(1) 400'd every load
  // ("Failed to load data. Please try refreshing."). Same bug class the
  // products DTO already fixed — see list-products.dto.spec.ts.
  it("accepts limit=0 (the fetch-all sentinel the Suppliers page sends)", () => {
    expect(validateQuery({ limit: "0" })).toEqual([]);
  });

  it("accepts paged limits up to the 200 cap", () => {
    expect(validateQuery({ limit: "20" })).toEqual([]);
    expect(validateQuery({ limit: "200" })).toEqual([]);
  });

  it("still rejects negative and over-cap limits", () => {
    expect(validateQuery({ limit: "-1" })).toContain("min");
    expect(validateQuery({ limit: "201" })).toContain("max");
  });

  it("still validates page (>= 1)", () => {
    expect(validateQuery({ page: "0" })).toContain("min");
    expect(validateQuery({ page: "1" })).toEqual([]);
  });
});
