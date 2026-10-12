import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Row 342 OWNER RULING: the hand-over stamp (cashier, register, time) is on STAFF views only, never on a customer copy: the
 * receipt, the invoice print / PDF and the emails. Only the two staff detail pages render it; anything else naming the
 * stamp (a receipt, a print view, a buyer page) is a new leak and goes red here.
 */
const ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", ".next", "e2e", "coverage"]);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) ? [p] : [];
  });

describe("hand-over stamp stays off customer copies (row 342)", () => {
  it("only the lib, the component, the staff reads' types and the two staff detail pages name it", () => {
    const users = walk(ROOT)
      .filter((p) => /handOverStampLine|HandOverStamp|handover-stamp/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(ROOT.length + 1))
      .sort();
    expect(users).toEqual([
      "app/(dashboard)/invoices/[id]/page.tsx",
      "app/(dashboard)/orders/[id]/page.tsx",
      "components/HandOverStamp.tsx",
      "lib/api/invoices.ts", // the staff read's type
      "lib/api/orders.ts", // the staff read's type
      "lib/handover-stamp.ts",
    ]);
  });
});
