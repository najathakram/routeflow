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

/** The names a customer copy must never carry: the stamp's helpers and the two stamped fields (row 374 e). */
const STAMP_NAMES = /handOverStampLine|HandOverStamp|handover-stamp|handedOverBy|registerKey/;

describe("hand-over stamp stays off customer copies (row 342)", () => {
  it("the scan catches each name (planted references)", () => {
    for (const planted of [
      "renderHandOverStamp(order)",
      'import { handOverStampLine } from "@/lib/handover-stamp";',
      "<p>{order.handedOverBy}</p>",
      "const r = invoice.order.registerKey;",
    ]) {
      expect(STAMP_NAMES.test(planted)).toBe(true);
    }
    expect(STAMP_NAMES.test("const cashier = receipt.cashier;")).toBe(false);
  });

  it("only the lib, the component, the staff reads' types, the staff detail pages and Today's hand-over rows name it", () => {
    const users = walk(ROOT)
      .filter((p) => STAMP_NAMES.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(ROOT.length + 1))
      .sort();
    expect(users).toEqual([
      "app/(dashboard)/invoices/[id]/page.tsx",
      "app/(dashboard)/orders/[id]/page.tsx",
      "app/(dashboard)/orders/_components/HandOverRows.tsx", // Today's sales hand-over rows (staff)
      "components/HandOverStamp.tsx",
      "lib/api/invoices.ts", // the staff read's type
      "lib/api/orders.ts", // the staff read's type
      "lib/handover-stamp.ts",
    ]);
  });
});
