import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import { DUNNING_CLOCK } from "@routeflow/types";
import {
  DUNNING_D3_HOURS,
  DUNNING_D7_HOURS,
  DUNNING_FINAL_LEAD_HOURS,
  DUNNING_LAST_DAY_HOURS,
  DUNNING_MILESTONES,
  DUNNING_PAUSE_HOURS,
} from "./dunning-config";
import { PAYMENT_FAILED_EMAIL_DEDUPE_DAYS } from "./dunning-config";

/**
 * SA-1037 r2 PR-6 (L-261): the dunning clock has ONE shape on both sides of the wire. The web banner imports
 * `DUNNING_CLOCK` from @routeflow/types; the API keeps its literals in dunning-config.ts. This pins them equal, so a
 * clock moved on one side fails here instead of showing "read-only tomorrow" on the wrong day.
 */
describe("DUNNING_CLOCK parity (API dunning-config = @routeflow/types)", () => {
  it("the API literals equal the shared clock", () => {
    expect(DUNNING_CLOCK).toEqual({
      d3Hours: DUNNING_D3_HOURS,
      d7Hours: DUNNING_D7_HOURS,
      lastDayHours: DUNNING_LAST_DAY_HOURS,
      finalLeadHours: DUNNING_FINAL_LEAD_HOURS,
      pauseHours: DUNNING_PAUSE_HOURS,
      graceDays: DUNNING_PAUSE_HOURS / 24,
    });
  });

  it("the pause is on day 14, the last day derived from it, the reminders on D3 and D7", () => {
    expect(DUNNING_PAUSE_HOURS).toBe(336);
    expect(DUNNING_LAST_DAY_HOURS).toBe(312);
    expect(DUNNING_LAST_DAY_HOURS).toBe(DUNNING_PAUSE_HOURS - DUNNING_FINAL_LEAD_HOURS);
    expect(DUNNING_D3_HOURS).toBe(72);
    expect(DUNNING_D7_HOURS).toBe(168);
  });

  it("G-j: the failed-payment email dedupe stays 7 days (independent of the pause hours)", () => {
    expect(PAYMENT_FAILED_EMAIL_DEDUPE_DAYS).toBe(7);
  });
});

/**
 * The owner's pre-flip evidence (`report-billing-pause-blast-radius.mjs`) is a plain .mjs and cannot import the TS
 * clock, so it carries its own copy of the pause hours and the milestone names it reads from the log. This pins that
 * third copy to the same shape (L-261); it is loaded in a child node process, as the other script specs do.
 */
describe("report-billing-pause-blast-radius.mjs carries the same clock (L-261)", () => {
  const SCRIPT_URL = pathToFileURL(
    path.resolve(__dirname, "..", "..", "scripts", "report-billing-pause-blast-radius.mjs"),
  ).href;
  const load = () => {
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as m from ${JSON.stringify(SCRIPT_URL)};
         process.stdout.write(JSON.stringify({ pauseHours: m.PAUSE_HOURS, milestones: m.REPORT_MILESTONES }));`,
      ],
      { encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`script import failed: ${res.stderr}`);
    return JSON.parse(res.stdout) as { pauseHours: number; milestones: string[] };
  };

  it("PAUSE_HOURS equals DUNNING_CLOCK.pauseHours (336)", () => {
    expect(load().pauseHours).toBe(DUNNING_CLOCK.pauseHours);
    expect(load().pauseHours).toBe(336);
  });

  it("the milestones it reads from the log are every milestone the dunning service writes, D7 included", () => {
    expect([...load().milestones].sort()).toEqual(Object.values(DUNNING_MILESTONES).sort());
  });

  it("--self-test passes on the 14-day clock (a tenant at 381 h is past the pause hours, one at 36 h is a countdown)", () => {
    const res = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", "..", "scripts", "report-billing-pause-blast-radius.mjs"),
        "--self-test",
      ],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/self-test ok/);
  });
});
