import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ListProductsDto } from "./list-products.dto";

/**
 * Query params arrive as strings; the global ValidationPipe uses
 * transform:true, so we mimic that with plainToInstance before validating.
 */
function validateQuery(query: Record<string, string>): string[] {
  const dto = plainToInstance(ListProductsDto, query);
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe("ListProductsDto.limit", () => {
  // Regression: the web uses limit=0 (fetch-all) and larger page sizes
  // (500/1000). The old @Min(1)@Max(200) rejected all of those with 400,
  // which left every "fetch-all" product picker empty.
  it("accepts limit=0 (the fetch-all sentinel)", () => {
    expect(validateQuery({ limit: "0" })).toEqual([]);
  });

  it("accepts large page sizes the web sends (500, 1000, 10000)", () => {
    expect(validateQuery({ limit: "500" })).toEqual([]);
    expect(validateQuery({ limit: "1000" })).toEqual([]);
    expect(validateQuery({ limit: "10000" })).toEqual([]);
  });

  it("still rejects negative and over-cap limits", () => {
    expect(validateQuery({ limit: "-1" })).toContain("min");
    expect(validateQuery({ limit: "10001" })).toContain("max");
  });

  it("still validates page (>= 1)", () => {
    expect(validateQuery({ page: "0" })).toContain("min");
    expect(validateQuery({ page: "1" })).toEqual([]);
  });
});
