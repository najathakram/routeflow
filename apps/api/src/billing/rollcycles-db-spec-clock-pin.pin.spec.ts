import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly } from "../testing/source-scan";

/**
 * L-353 class guard, DB lane. `BillingCronService.rollCycles` rolls an externalPayment row onto the owner's calendar:
 * an old period end within 24 h of the 1st at 12:00Z snaps to that boundary. A DB spec that calls the REAL method on
 * the wall clock and then compares the rolled `periodStart` with a time derived from `Date.now()` is therefore green
 * on most days and red for about 23 h after each 1st at 12:00Z, with no commit to blame. Every such spec pins the
 * clock with `pinWallClock`; the unit specs feed `rollCycles` fixed dates through a mocked client and are not scanned.
 * The scan covers every `*.db.spec.ts` under `apps/api/src`, in any folder, and finds the real service by name or by
 * import path, so a spec outside `billing/` or one that imports it through a barrel is held to the same rule.
 */

// The real service is reached by its class name (an import from any path or barrel, `moduleRef.get(...)`) or by the
// module path in any import form (`from`, `require`, `import()`), from any folder. Comments are blanked first.
const REAL_CRON = /\bBillingCronService\b|billing-cron\.service["'`]/;
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

  it("detector: sees the real service however the spec reaches it (subfolder, outside folder, barrel, require, dynamic import)", () => {
    const call = "await new BillingCronService(a).rollCycles();";
    const reaches: Array<[string, string]> = [
      [
        "billing/sub/a.db.spec.ts",
        `import { BillingCronService } from "../billing-cron.service";\n${call}`,
      ],
      [
        "orders/b.db.spec.ts",
        `import { BillingCronService } from "../billing/billing-cron.service";\n${call}`,
      ],
      [
        "c.db.spec.ts",
        `import { BillingCronService } from "src/billing/billing-cron.service";\n${call}`,
      ],
      [
        "d.db.spec.ts",
        `import {\n  BillingCronService,\n} from '../../billing/billing-cron.service';\n${call}`,
      ],
      ["e.db.spec.ts", `import { BillingCronService } from "../billing";\n${call}`],
      [
        "f.db.spec.ts",
        `const { BillingCronService } = require("../billing/billing-cron.service");\n${call}`,
      ],
      [
        "g.db.spec.ts",
        `const m = await import("../billing/billing-cron.service");\nawait new m.BillingCronService(a).rollCycles();`,
      ],
      ["h.db.spec.ts", "const cron = moduleRef.get(BillingCronService);\nawait cron.rollCycles();"],
    ];
    for (const [rel, text] of reaches) {
      const pinned = `${text}\npinWallClock();`;
      expect({ rel, flagged: unpinnedRollCyclesCallers([{ rel, text }]) }).toEqual({
        rel,
        flagged: [rel],
      });
      expect({ rel, flagged: unpinnedRollCyclesCallers([{ rel, text: pinned }]) }).toEqual({
        rel,
        flagged: [],
      });
    }
    // a lookalike name, a commented-out import and a mock are not the real service
    for (const text of [
      "class MyBillingCronServiceStub { rollCycles() {} }\nnew MyBillingCronServiceStub().rollCycles();",
      '// import { BillingCronService } from "../billing/billing-cron.service";\nsvc.rollCycles();',
      "const svc = { rollCycles: jest.fn() };\nsvc.rollCycles();",
    ]) {
      expect({ text, flagged: unpinnedRollCyclesCallers([{ rel: "x.db.spec.ts", text }]) }).toEqual(
        {
          text,
          flagged: [],
        },
      );
    }
  });

  it("every DB spec that calls the real rollCycles pins the clock with pinWallClock", () => {
    const files = dbSpecFiles(API_SRC_ROOT).map((full) => ({
      rel: path.relative(API_SRC_ROOT, full).split(path.sep).join("/"),
      text: fs.readFileSync(full, "utf8"),
    }));
    // an empty scan must never report green: the spec this guard was written for is in it
    expect(files.map((f) => f.rel)).toContain("billing/trial-addon-checkout.db.spec.ts");
    // and the walk reaches past billing/ and into subfolders, where the old import match could not see
    expect(files.some((f) => !f.rel.startsWith("billing/"))).toBe(true);
    expect(files.some((f) => f.rel.split("/").length > 2)).toBe(true);
    expect(unpinnedRollCyclesCallers(files)).toEqual([]);
  });
});
