/**
 * SA-943 PR-A (W-765, L-167 class) — structural pin: a request's paid / settled / received date reaches an INSTANT column
 * only through `common/paid-instant.ts`. `new Date(dto.paidAt)` on a date-only "YYYY-MM-DD" is 00:00Z — the previous
 * evening for every tenant west of UTC — which is how a same-day payment landed in yesterday's closed counter window.
 *
 * Walks `apps/api/src` and fails when a non-spec file builds a Date straight from a request field
 * (`new Date(dto.paidAt | dto.settledAt | dto.receivedAt)`), outside the allow-list below; and when a listed writer stops
 * importing the helper. Style: `tenant-zone-single-reader.spec.ts`.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join("/");

/**
 * `new Date(dto.paidAt)`, `new Date(dto.settledAt as string)`, `new Date(dto?.receivedAt)`, and the same off any request-shaped
 * holder (`body`, `input`, `params`, `args`, `payload`, `data`) or a nested path (`dto.payment.paidAt`), for the paid / settled /
 * received date fields and their `…Date` spellings.
 */
const RAW_REQUEST_DATE =
  /\bnew Date\(\s*(?:dto|body|input|params|args|payload|data)\s*\??\.\s*(?:\w+\s*\??\.\s*)*(?:paidAt|settledAt|receivedAt|paidDate|receivedDate)\b/g;

/** The ONLY raw constructions left, each with how many and why. A new one is a red bar, never a silent addition. */
const ALLOW_LIST: Record<string, { count: number; reason: string }> = {
  "invoices/counter-payment-guard.ts": {
    count: 1,
    reason:
      "the guard receives the ALREADY-resolved instant (Date | null) from its callers; the SA-943 ruling keeps the guard unchanged",
  },
  "bookkeeping/bookkeeping.service.ts": {
    count: 2,
    reason:
      "Expense buildStatusPatch (receivedAt / paidAt): moves onto keptPaidInstantOf in SA-985 / PR-A2 (allow-list 2 -> 0), ruled out of PR-A",
  },
  "sales-agents/commission-statements.service.ts": {
    count: 1,
    reason:
      "Expense.date is a CALENDAR column and never goes through the instant helper; the payout's paidAt does",
  },
};

/** Every writer SA-943 PR-A moved onto the helper: each must keep importing it. */
const WRITERS = [
  "invoices/invoices.service.ts",
  "vendor-bills/vendor-bills.service.ts",
  "bookkeeping/bookkeeping.service.ts",
  "customers/customers.service.ts",
  "sales-agents/commission-statements.service.ts",
];
const IMPORTS_HELPER = /from\s+["']\.\.\/common\/paid-instant["']/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("paid-instant writers inventory (SA-943)", () => {
  const files = walk(SRC_ROOT);

  it("no request paid / settled / received date becomes a Date outside the helper (allow-list exact)", () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const n = (stripComments(fs.readFileSync(file, "utf8")).match(RAW_REQUEST_DATE) ?? []).length;
      if (n > 0) found[rel(file)] = n;
    }
    const expected = Object.fromEntries(Object.entries(ALLOW_LIST).map(([f, v]) => [f, v.count]));
    expect(found).toEqual(expected);
  });

  it.each(WRITERS)("%s imports the paid-instant helper", (file) => {
    const src = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
    expect(IMPORTS_HELPER.test(src)).toBe(true);
  });

  it("the pin bites: a raw request date in a fixture is counted", () => {
    const fixture = `const a = new Date(dto.paidAt);\nconst b = new Date(dto?.settledAt as string);\n// new Date(dto.receivedAt)`;
    expect((stripComments(fixture).match(RAW_REQUEST_DATE) ?? []).length).toBe(2);
    const wider = `new Date(body.paidAt); new Date(dto.payment?.receivedAt); new Date(input.paidDate); new Date(row.paidAt)`;
    expect((stripComments(wider).match(RAW_REQUEST_DATE) ?? []).length).toBe(3);
  });
});
