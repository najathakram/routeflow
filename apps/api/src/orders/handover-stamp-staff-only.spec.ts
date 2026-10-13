import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Row 342 OWNER RULING: who handed an order over (cashier, register) is shown on STAFF views only, never on a customer copy:
 * the receipt, the invoice / statement / packing-slip PDFs and the emails. The stamp's helpers and fields are read by exactly
 * the staff reads (orders / invoices findOne) and Today's sales; a customer-copy source that names one is a new leak, so this
 * scan goes red on it.
 *
 * What is scanned: every non-spec .ts / .tsx file under documents/, messaging/ and email/, plus every file anywhere in src whose
 * name says it IS a customer document (pdf, template, attachment, receipt, statement, packing, label).
 * The one allowance: the receipt's own `Cashier:` line (row 317, the user who rang the sale) reads `soldBy`, in exactly the two
 * files below. `registerKey`, `handedOverBy` and the stamp helpers are never allowed on a customer copy, those two included.
 */
const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.(spec|test)\.(ts|tsx)$/.test(n) ? [p] : [];
  });

const NEVER =
  /handedOverBy|registerKey|HANDOVER_SOLD_BY_SELECT|stampHandedOverBy|seesHandOverStamp/;
const CASHIER = /soldBy/;
/** row 317: the customer receipt's `Cashier:` line (the sale's own cashier), not the hand-over stamp */
const CASHIER_LINE_FILES = new Set(["documents/receipt-model.ts", "documents/receipt.service.ts"]);

/** The leaks in one source text (pure, so the scan itself is proven below against planted references). */
function stampLeaks(rel: string, text: string): string[] {
  const leaks: string[] = [];
  if (NEVER.test(text)) leaks.push("stamp field or helper");
  if (CASHIER.test(text) && !CASHIER_LINE_FILES.has(rel)) leaks.push("soldBy");
  return leaks;
}

const DOC_NAME = /pdf|template|attachment|receipt|statement|packing|label/i;
const customerCopies = (): string[] => {
  const dirs = ["documents", "messaging", "email"].flatMap((d) => walk(join(SRC, d)));
  const named = walk(SRC).filter((p) => DOC_NAME.test(p.slice(p.lastIndexOf("/") + 1)));
  return [...new Set([...dirs, ...named])].sort();
};

describe("hand-over stamp stays off customer copies (row 342)", () => {
  const files = customerCopies();
  const rel = (p: string) => relative(SRC, p);

  it("the scan reaches the .tsx document templates, documents/, messaging/ and email/", () => {
    const names = files.map(rel);
    for (const must of [
      "invoices/invoice-pdf-template.tsx",
      "buyer/statement-pdf-template.tsx",
      "orders/packing-slip-pdf-template.tsx",
      "documents/render-order-receipt.ts",
    ]) {
      expect(names).toContain(must);
    }
    expect(names.some((n) => n.startsWith("messaging/"))).toBe(true);
    expect(names.some((n) => n.startsWith("email/"))).toBe(true);
    expect(files.length).toBeGreaterThan(15);
  });

  it("a planted reference is caught (the scan goes red on a leak)", () => {
    expect(stampLeaks("invoices/invoice-pdf-template.tsx", "const r = order.registerKey;")).toEqual(
      ["stamp field or helper"],
    );
    expect(stampLeaks("orders/packing-slip-pdf-template.tsx", "o.handedOverBy ?? ''")).toEqual([
      "stamp field or helper",
    ]);
    expect(stampLeaks("email/mail.ts", "select: { soldBy: true }")).toEqual(["soldBy"]);
    // the receipt's cashier line is the one allowance; the register and the stamp are still refused there
    expect(
      stampLeaks("documents/receipt-model.ts", "cashier: cashierNameOf(order.soldBy)"),
    ).toEqual([]);
    expect(stampLeaks("documents/receipt-model.ts", "registerKey: order.registerKey")).toEqual([
      "stamp field or helper",
    ]);
  });

  it.each(files.map((p) => [rel(p), p]))("%s never names the stamp", (name, p) => {
    expect(stampLeaks(name, readFileSync(p, "utf8"))).toEqual([]);
  });

  it("only the staff reads import the stamp helpers", () => {
    const HELPERS = /handedOverBy|HANDOVER_SOLD_BY_SELECT|stampHandedOverBy|seesHandOverStamp/;
    const users = walk(SRC)
      .filter((p) => HELPERS.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual([
      "invoices/invoices.service.ts",
      "orders/counter-sale/counter-sale-today.ts",
      "orders/handover-stamp.ts",
      "orders/orders.service.ts",
    ]);
  });
});
