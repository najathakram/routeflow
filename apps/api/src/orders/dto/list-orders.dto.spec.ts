import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ListOrdersDto } from "./list-orders.dto";

/**
 * Query params arrive as strings; the global ValidationPipe uses
 * transform:true, so we mimic that with plainToInstance before validating.
 */
function validateQuery(query: Record<string, string>): string[] {
  const dto = plainToInstance(ListOrdersDto, query);
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

// T3-pin (F16, REG-B144's sibling fix): `limit` had no upper bound at all
// (@IsInt() @Min(1), no @Max) — a single request could force an unbounded
// order scan. MAX_LIST_LIMIT (1000) is the shared cap every other list DTO
// in this codebase enforces (apps/api/src/common/pagination.ts).
//
// The two `pin (T3-pin)` cases below pass on the pre-fix DTO too — with no @Max
// at all, validateSync returns [] for ANY limit — so the boundary case only
// becomes a real control once @Max(MAX_LIST_LIMIT) lands. They are titled as
// pins (and carry no REG-B token) so the red gate never selects a test that is
// expected to be green.
describe("ListOrdersDto.limit", () => {
  it("rejects limit=5000 (over MAX_LIST_LIMIT)", () => {
    expect(validateQuery({ limit: "5000" })).toContain("max");
  });

  it("pin (T3-pin): accepts limit=1000 (exactly MAX_LIST_LIMIT)", () => {
    expect(validateQuery({ limit: "1000" })).toEqual([]);
  });

  it("pin (T3-pin): still validates page (>= 1)", () => {
    expect(validateQuery({ page: "0" })).toContain("min");
    expect(validateQuery({ page: "1" })).toEqual([]);
  });
});
