/**
 * W-781 - owner-run reports (stock-ledger-gap.mjs "lastMovementAt") read Prisma `timestamp(3)`
 * columns through node-postgres, which parses them as HOST-LOCAL time. Pinned under a non-UTC TZ.
 * SA-952: the parser has one home (scripts/lib/pause-report-keys.mjs, own spec in
 * billing/pause-report-keys.spec.ts); this spec pins the premise and the report's wiring only.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * V8 caches the host zone at the first Date use, and a Jest worker's `process.env` is a copy, so setting
 * TZ inside the worker never reaches the real process: the premise only held on a host already in
 * Chicago and failed on a UTC CI runner (see utc-day.spec.ts, pdf-date.spec.ts). The parse runs in a
 * CHILD node process started with TZ set, so it is non-vacuous on every parent host.
 */
function parseInZone(tz: string, raw: string): string {
  const script = `
    const pg = require("pg");
    process.stdout.write(pg.types.getTypeParser(1114)(process.argv[1]).toISOString());
  `;
  return execFileSync(process.execPath, ["-e", script, raw], {
    env: { ...process.env, TZ: tz },
    cwd: join(__dirname, "..", ".."),
    encoding: "utf8",
  });
}

describe("W-781 pg timestamp (no zone) is read as UTC on a non-UTC host", () => {
  it("premise: pg's default parser shifts by the host offset (the bug)", () => {
    const old = parseInZone("America/Chicago", "2026-01-15 12:00:00.123");
    expect(old).not.toBe("2026-01-15T12:00:00.123Z");
    expect(old).toBe("2026-01-15T18:00:00.123Z"); // CST = UTC-6
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
