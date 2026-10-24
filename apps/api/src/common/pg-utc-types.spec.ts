/**
 * W-781 - owner-run reports (stock-ledger-gap.mjs "lastMovementAt") read Prisma `timestamp(3)`
 * columns through node-postgres, which parses them as HOST-LOCAL time. Pinned under a non-UTC TZ.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  parseUtcTimestamp,
  utcTimestampTypes,
  TIMESTAMP_OID,
} = require("../../scripts/lib/pg-utc-types.cjs");
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

  const RAW = "2026-01-15 12:00:00.123";

  it("premise: pg's default parser shifts by the host offset (the bug)", () => {
    const old = pg.types.getTypeParser(TIMESTAMP_OID)(RAW) as Date;
    expect(old.toISOString()).not.toBe("2026-01-15T12:00:00.123Z");
    expect(old.toISOString()).toBe("2026-01-15T18:00:00.123Z"); // CST = UTC-6
  });

  it("the shared parser returns the stored UTC instant", () => {
    expect(parseUtcTimestamp(RAW).toISOString()).toBe("2026-01-15T12:00:00.123Z");
    expect(parseUtcTimestamp("2026-07-15 12:00:00.5").toISOString()).toBe(
      "2026-07-15T12:00:00.500Z",
    );
    expect(parseUtcTimestamp(null)).toBeNull();
  });

  it("utcTimestampTypes overrides only OID 1114", () => {
    expect(utcTimestampTypes.getTypeParser(TIMESTAMP_OID, "text")(RAW).toISOString()).toBe(
      "2026-01-15T12:00:00.123Z",
    );
    expect(utcTimestampTypes.getTypeParser(23, "text")("42")).toBe(42);
  });

  it("stock-ledger-gap.mjs builds its Pool with the UTC types", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "scripts", "stock-ledger-gap.mjs"),
      "utf8",
    );
    expect(src).toMatch(/new pg\.Pool\(\{[^}]*types: utcTimestampTypes/);
  });
});
