/**
 * B954: PDF date formatting must be anchored to UTC. Calendar dates (issue/due/statement days) are
 * stored as UTC-midnight instants; formatted with the host's LOCAL zone they render a day early on
 * any host west of UTC. Railway runs UTC so prod hides it. V8 caches the zone at the first Date use,
 * so setting process.env.TZ inside a Jest worker is unreliable (it only "worked" on a host already
 * west of UTC). Each assertion therefore runs the real helper in a CHILD node process started with
 * TZ=America/Los_Angeles, so the spec is non-vacuous on ANY host. The templates are `.tsx` and
 * stubbed under Jest, so the rule lives in this pure helper.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { fmtPdfDate } from "./pdf-date";

const SOURCE = ts.transpileModule(readFileSync(join(__dirname, "pdf-date.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

/** Runs the real fmtPdfDate in a fresh node process whose host zone is Los Angeles. */
function inLosAngeles(inputs: unknown[]): { hostDay: number; out: string[] } {
  const script = `
    const m = { exports: {} };
    new Function("module", "exports", ${JSON.stringify(SOURCE)})(m, m.exports);
    const inputs = JSON.parse(process.argv[1]);
    const hostDay = new Date("2026-01-15T00:00:00.000Z").getDate();
    process.stdout.write(JSON.stringify({ hostDay, out: inputs.map((v) => m.exports.fmtPdfDate(v)) }));
  `;
  const stdout = execFileSync(process.execPath, ["-e", script, JSON.stringify(inputs)], {
    env: { ...process.env, TZ: "America/Los_Angeles" },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

describe("fmtPdfDate is UTC-anchored (B954)", () => {
  it("the child host really is west of UTC (guards a vacuous pass, on ANY parent host)", () => {
    expect(inLosAngeles([]).hostDay).toBe(14);
  });

  it("a UTC-midnight calendar date renders as THAT day, not the day before", () => {
    expect(inLosAngeles(["2026-01-15T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]).out).toEqual([
      "Jan 15, 2026",
      "Mar 1, 2026",
    ]);
  });

  it("the last millisecond of a UTC day stays on that day; the first of the next moves on", () => {
    expect(inLosAngeles(["2026-01-31T23:59:59.999Z", "2026-02-01T00:00:00.000Z"]).out).toEqual([
      "Jan 31, 2026",
      "Feb 1, 2026",
    ]);
  });

  it("null, undefined and an empty string render an em dash", () => {
    expect(fmtPdfDate(null)).toBe("—");
    expect(fmtPdfDate(undefined)).toBe("—");
    expect(fmtPdfDate("")).toBe("—");
  });
});
