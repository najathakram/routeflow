/**
 * W-781 - owner-run reports (stock-ledger-gap.mjs "lastMovementAt") read Prisma `timestamp(3)`
 * columns through node-postgres, which parses them as HOST-LOCAL time. Pinned under a non-UTC TZ.
 * SA-952: the parser has one home (scripts/lib/pause-report-keys.mjs, own spec in
 * billing/pause-report-keys.spec.ts); this spec pins the premise and the report's wiring only.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = require("pg");
import { readFileSync } from "fs";
import { join } from "path";

describe("W-781 pg timestamp (no zone) is read as UTC on a non-UTC host", () => {
  const prevTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Chicago";
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it("premise: pg's default parser shifts by the host offset (the bug)", () => {
    const old = pg.types.getTypeParser(1114)("2026-01-15 12:00:00.123") as Date;
    expect(old.toISOString()).not.toBe("2026-01-15T12:00:00.123Z");
    expect(old.toISOString()).toBe("2026-01-15T18:00:00.123Z"); // CST = UTC-6
  });

  it("stock-ledger-gap.mjs builds its Pool with the shared UTC types", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "scripts", "stock-ledger-gap.mjs"),
      "utf8",
    );
    expect(src).toContain('from "./lib/pause-report-keys.mjs"');
    expect(src).toMatch(/types:\s*utcTimestampTypes\(pg\.types\)/);
    expect(src).not.toContain("pg-utc-types.cjs");
  });
});
