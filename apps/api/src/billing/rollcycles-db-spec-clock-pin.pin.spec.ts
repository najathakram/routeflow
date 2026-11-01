import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly } from "../testing/source-scan";

/**
 * L-353 class guard, DB lane. `BillingCronService.rollCycles` rolls an externalPayment row onto the owner's calendar:
 * an old period end within 24 h of the 1st at 12:00Z snaps to that boundary. A DB spec that calls the REAL method on
 * the wall clock and then compares the rolled `periodStart` with a time derived from `Date.now()` is therefore green
 * on most days and red for about 23 h after each 1st at 12:00Z, with no commit to blame. Every such spec pins the
 * clock with `pinWallClock`; the unit specs feed `rollCycles` fixed dates through a mocked client and are not scanned.
 */

const REAL_CRON = /from\s+["']\.\/billing-cron\.service["']/;
const CALLS_ROLL = /\.rollCycles\(/;
const PINS_CLOCK = /\bpinWallClock\(/;

function dbSpecFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") dbSpecFiles(full, out);
    } else if (/\.db\.spec\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

/** DB specs that call a real `rollCycles` and do not pin the clock with the shared helper. */
export function unpinnedRollCyclesCallers(files: Array<{ rel: string; text: string }>): string[] {
  return files
    .filter(({ text }) => {
      const code = codeOnly(text);
      return REAL_CRON.test(code) && CALLS_ROLL.test(code) && !PINS_CLOCK.test(code);
    })
    .map(({ rel }) => rel);
}

describe("DB specs that roll a billing cycle pin the wall clock (L-353)", () => {
  it("detector: flags a real-cron caller with no pin, passes a pinned one, ignores a mock-only spec", () => {
    const real =
      'import { BillingCronService } from "./billing-cron.service";\nawait new BillingCronService(a).rollCycles();';
    expect(unpinnedRollCyclesCallers([{ rel: "a.db.spec.ts", text: real }])).toEqual([
      "a.db.spec.ts",
    ]);
    expect(
      unpinnedRollCyclesCallers([{ rel: "b.db.spec.ts", text: `${real}\npinWallClock();` }]),
    ).toEqual([]);
    expect(
      unpinnedRollCyclesCallers([
        { rel: "c.db.spec.ts", text: "const svc = { rollCycles: jest.fn() };\nsvc.rollCycles();" },
      ]),
    ).toEqual([]);
    // a pin that exists only in a comment does not count
    expect(
      unpinnedRollCyclesCallers([
        { rel: "d.db.spec.ts", text: `${real}\n// pinWallClock() later` },
      ]),
    ).toEqual(["d.db.spec.ts"]);
  });

  it("every DB spec that calls the real rollCycles pins the clock with pinWallClock", () => {
    const files = dbSpecFiles(API_SRC_ROOT).map((full) => ({
      rel: path.relative(API_SRC_ROOT, full).split(path.sep).join("/"),
      text: fs.readFileSync(full, "utf8"),
    }));
    // an empty scan must never report green: the spec this guard was written for is in it
    expect(files.map((f) => f.rel)).toContain("billing/trial-addon-checkout.db.spec.ts");
    expect(unpinnedRollCyclesCallers(files)).toEqual([]);
  });
});
