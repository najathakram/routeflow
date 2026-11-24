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

describe("ListProductsDto.ids (P-21: a batch read by ids)", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => uuid(i + 1));
  const parse = (ids: string) => plainToInstance(ListProductsDto, { ids });

  it("I1/I2: accepts 1 to 200 ids and rejects 201 with the size constraint", () => {
    expect(validateQuery({ ids: uuid(1) })).toEqual([]);
    expect(validateQuery({ ids: many(200).join(",") })).toEqual([]);
    expect(validateQuery({ ids: many(201).join(",") })).toContain("arrayMaxSize");
  });

  it("I3: a value that is not a UUID is rejected", () => {
    expect(validateQuery({ ids: `${uuid(1)},not-a-uuid` })).toContain("isUuid");
  });

  it("an empty ids value is a 400, never a silent whole-catalog read", () => {
    expect(validateQuery({ ids: "" })).toContain("arrayMinSize");
  });

  it("splits on commas, trims and drops repeats", () => {
    expect(parse(` ${uuid(1)} , ${uuid(2)},${uuid(1)}`).ids).toEqual([uuid(1), uuid(2)]);
  });
});
