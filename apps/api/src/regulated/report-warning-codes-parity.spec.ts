import { REPORT_WARNING_CODES } from "./report-types";

/**
 * B987-D: the regulated-report warning codes are sent by the API (`ReportWarning.code`) and typed by web and mobile through
 * `RegulatedReportWarningCode` in `@routeflow/types`. The API cannot value-import that package (see
 * `no-runtime-workspace-imports.spec.ts`), so it keeps a local copy of the list, pinned here against the shared one: same members
 * AND the same order, so a code added on one side only (as PARKED_REVERSALS once was) fails this spec instead of reaching a
 * client whose type has never heard of it.
 */
function readShared(): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require("@routeflow/types") as Record<string, unknown>;
  return (shared.REGULATED_REPORT_WARNING_CODES ?? []) as readonly string[];
}

describe("regulated report warning codes: API copy = shared list (B987-D)", () => {
  it("the shared list exists and is non-empty (guards a missing export turning the pin vacuous)", () => {
    expect(readShared().length).toBeGreaterThan(0);
  });

  it("the API's REPORT_WARNING_CODES equals @routeflow/types' REGULATED_REPORT_WARNING_CODES (members and order)", () => {
    expect([...REPORT_WARNING_CODES]).toEqual([...readShared()]);
  });

  it("has no duplicates and every code is UPPER_SNAKE", () => {
    expect(new Set(REPORT_WARNING_CODES).size).toBe(REPORT_WARNING_CODES.length);
    for (const c of REPORT_WARNING_CODES) expect(c).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});
