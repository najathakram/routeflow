/**
 * B955: startOfUtcDay returns the UTC calendar day's 00:00:00.000Z on ANY host zone. V8 caches the
 * zone at the first Date use, so setting TZ inside a Jest worker is unreliable (B954 / #2939). Each
 * assertion runs the real helper in a CHILD node process started with the given TZ, so the spec is
 * non-vacuous on every parent host, including a UTC CI runner.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const SOURCE = ts.transpileModule(readFileSync(join(__dirname, "utc-day.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

/** Runs the real startOfUtcDay on each ISO input in a fresh node process whose zone is `tz`. */
function inZone(
  tz: string,
  inputs: string[],
  fn: "startOfUtcDay" | "isoWeekdayUtc" = "startOfUtcDay",
): { hostDay: number; out: (string | number)[] } {
  const script = `
    const m = { exports: {} };
    new Function("module", "exports", ${JSON.stringify(SOURCE)})(m, m.exports);
    const inputs = JSON.parse(process.argv[1]);
    const hostDay = new Date("2026-01-15T00:30:00.000Z").getDate();
    process.stdout.write(JSON.stringify({
      hostDay,
      out: inputs.map((v) => {
        const r = m.exports[${JSON.stringify(fn)}](new Date(v));
        return r instanceof Date ? r.toISOString() : r;
      }),
    }));
  `;
  const stdout = execFileSync(process.execPath, ["-e", script, JSON.stringify(inputs)], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

const INPUTS = [
  "2026-01-15T00:30:00.000Z",
  "2026-01-14T23:59:59.999Z",
  "2026-01-15T00:00:00.000Z",
  "2026-01-15T23:59:59.999Z",
  "2026-03-08T10:00:00.000Z", // a US DST-change day
];
const EXPECTED = [
  "2026-01-15T00:00:00.000Z",
  "2026-01-14T00:00:00.000Z",
  "2026-01-15T00:00:00.000Z",
  "2026-01-15T00:00:00.000Z",
  "2026-03-08T00:00:00.000Z",
];

describe("startOfUtcDay (B955)", () => {
  it("the child host really is west of UTC (guards a vacuous pass, on ANY parent host)", () => {
    expect(inZone("America/Los_Angeles", []).hostDay).toBe(14);
    expect(inZone("Asia/Tokyo", []).hostDay).toBe(15);
  });

  it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC", "Pacific/Kiritimati"])(
    "returns the UTC midnight of the UTC day under TZ=%s",
    (tz) => {
      expect(inZone(tz, INPUTS).out).toEqual(EXPECTED);
    },
  );
});

describe("isoWeekdayUtc (B955: the daily generator's weekday is the UTC weekday)", () => {
  // Just after UTC midnight Thu is still WEDNESDAY in LA; just before UTC midnight Wed is already
  // THURSDAY in Tokyo. Sunday must be 7 (ISO), not 0.
  const CASES: [string, number][] = [
    ["2026-01-15T00:30:00.000Z", 4], // Thu UTC (Wed 16:30 in LA)
    ["2026-01-14T23:30:00.000Z", 3], // Wed UTC (Thu 08:30 in Tokyo)
    ["2026-01-18T00:30:00.000Z", 7], // Sun UTC (Sat in LA)
    ["2026-01-12T23:59:59.999Z", 1], // Mon UTC (Tue in Tokyo)
  ];

  it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC", "Pacific/Kiritimati"])(
    "returns the UTC ISO weekday near midnight under TZ=%s",
    (tz) => {
      expect(
        inZone(
          tz,
          CASES.map(([iso]) => iso),
          "isoWeekdayUtc",
        ).out,
      ).toEqual(CASES.map(([, day]) => day));
    },
  );
});
