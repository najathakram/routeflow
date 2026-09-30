/**
 * T5-guard (REG-B117) — static guard: neither supplier-statements service may
 * keep its OWN `vendorBill.findMany` candidate-pool query (with its `take: 500`
 * cap and no `orderBy`). Both must import the shared `fetchMatchableBills` from
 * `./matchable-bills` instead — the byte-copy between these two files is
 * exactly how REG-B117 (and its `take: 500` cap) drifted into a SECOND site.
 *
 * Walks the two known files by text rather than asserting on their exports, so
 * a re-introduced private copy fails here even if it's never actually called
 * by anything else — same shape as `apps/api/src/common/no-bare-cron.spec.ts`.
 */

import * as fs from "fs";
import * as path from "path";

const DIR = path.resolve(__dirname);
const FILES = [
  path.join(DIR, "supplier-statements.service.ts"),
  path.join(DIR, "statement-apply.service.ts"),
];

const TAKE_500 = /take:\s*500\b/;
const VENDOR_BILL_FIND_MANY = /\.vendorBill\.findMany\s*\(/;
const IMPORTS_SHARED_HELPER = /\bfetchMatchableBills\b[^;]*from\s*["']\.\/matchable-bills["']/;

// The describe deliberately carries NO REG-B token: the anti-vacuity self-check below
// passes today AND after the fix, so the red gate's `-t "REG-B"` selection must not pick
// it up. Same convention as apps/api/src/analytics/analytics.service.calendar.spec.ts:80-81.
describe("matchable-bills guard (T5-guard, F16 supplier-statements pool)", () => {
  it("walks both known service files (guards against an empty/misconfigured scan reporting green)", () => {
    for (const file of FILES) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it("REG-B117 neither service file contains its own `take: 500` candidate-pool cap", () => {
    const offenders = FILES.filter((f) => TAKE_500.test(fs.readFileSync(f, "utf8"))).map((f) =>
      path.basename(f),
    );
    expect(offenders).toEqual([]);
  });

  it("REG-B117 neither service file runs its own `vendorBill.findMany` for the matchable-bills pool", () => {
    const offenders = FILES.filter((f) =>
      VENDOR_BILL_FIND_MANY.test(fs.readFileSync(f, "utf8")),
    ).map((f) => path.basename(f));
    expect(offenders).toEqual([]);
  });

  it("REG-B117 both service files import `fetchMatchableBills` from ./matchable-bills", () => {
    const missing = FILES.filter(
      (f) => !IMPORTS_SHARED_HELPER.test(fs.readFileSync(f, "utf8")),
    ).map((f) => path.basename(f));
    expect(missing).toEqual([]);
  });
});
