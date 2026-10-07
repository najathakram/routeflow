import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * #2717 M3 (SA-572 I5, SA-589, case 16): `displayUnitPrice4` is display data. It is WRITTEN once per
 * document line by the composition writers and READ only by the PDF sub-line mapper and the
 * component view mappers. No sum, tax, credit, reconcile or report path may read it. The scan
 * below is text-based (comments blanked): any non-spec source file under apps/api/src that names
 * the identifier must be on the allowlist, with the reason it is there.
 */
const SRC_ROOT = join(__dirname, "..");

const ALLOW: Record<string, string> = {
  "orders/line-composition.ts": "writer: order component rows at write time",
  "invoices/invoice-line-composition.ts": "writer: invoice component rows at bill time",
  "invoices/invoice-composed-edit.ts": "writer: re-stamps the rows on a DRAFT edit",
  "invoices/invoice-pdf-item.ts": "reader: the PDF sub-line price text",
  "orders/component-view.ts": "reader: read mapper for the component view (findOne)",
  "common/staff-only-fields.ts":
    "carry: the customer-facing allowlist copies the component view's field through, never summed",
  "orders/order-edit-composition.ts":
    "carry: restores the stored rows' value on an edit (SA-591), never summed",
};

/** Files that compute money from lines; they must never name the identifier at all. */
const MONEY_PATHS = [
  "invoices/invoice-edit-plan.ts",
  "invoices/finalize-order-recompute.ts",
  "invoices/delivered-reconcile.ts",
  "invoices/delivered-basis-by-line.ts",
  "invoices/manual-invoice-lines.ts",
  "invoices/price-adjustment-ledger.ts",
  "common/money-invariants.util.ts",
];
const MONEY_DIRS = ["credit-notes", "sales-facts", "analytics", "bookkeeping", "returns"];

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** True when the source text names the identifier outside a comment. */
export function readsDisplayUnitPrice4(text: string): boolean {
  return /\bdisplayUnitPrice4\b/.test(withoutComments(text));
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !/\.(spec|test|d)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Which of these files sit in a money path or a money directory (they must never name it). */
function moneyViolations(files: string[]): string[] {
  return files.filter(
    (f) => MONEY_DIRS.some((d) => f.startsWith(`${d}/`)) || MONEY_PATHS.includes(f),
  );
}

describe("displayUnitPrice4 is display-only (I5, case 16)", () => {
  const sourceFiles = listTsFiles(SRC_ROOT);
  const namers = sourceFiles
    .map((f) => ({
      rel: relative(SRC_ROOT, f).split("\\").join("/"),
      text: readFileSync(f, "utf8"),
    }))
    .filter((f) => readsDisplayUnitPrice4(f.text))
    .map((f) => f.rel);

  it("is not vacuous: it scans the tree and finds every allowlisted file naming the identifier", () => {
    expect(sourceFiles.length).toBeGreaterThan(300);
    expect(namers.length).toBeGreaterThanOrEqual(Object.keys(ALLOW).length);
    expect(namers.length).toBeGreaterThanOrEqual(5);
    // every money path the guard lists must still exist, else that half of the guard checks nothing
    const rels = new Set(sourceFiles.map((f) => relative(SRC_ROOT, f).split("\\").join("/")));
    expect(MONEY_PATHS.filter((f) => !rels.has(f))).toEqual([]);
  });

  it("negative control: a fixture naming it in a money path, a money directory and a stray file is reported", () => {
    const fixture = "const price = row.displayUnitPrice4;";
    const fixtureFiles = [
      "invoices/invoice-edit-plan.ts",
      "analytics/report.ts",
      "orders/stray.ts",
    ];
    const naming = fixtureFiles.filter(() => readsDisplayUnitPrice4(fixture));
    expect(naming).toEqual(fixtureFiles);
    expect(naming.filter((f) => !(f in ALLOW))).toEqual(fixtureFiles); // the allowlist check rejects all three
    expect(moneyViolations(naming)).toEqual([
      "invoices/invoice-edit-plan.ts",
      "analytics/report.ts",
    ]);
    expect(moneyViolations(["orders/component-view.ts"])).toEqual([]);
  });

  it("only allowlisted files name it", () => {
    expect(namers.filter((f) => !(f in ALLOW))).toEqual([]);
  });

  it("every allowlist entry is real and still names it (no stale entry)", () => {
    expect(Object.keys(ALLOW).filter((f) => !namers.includes(f))).toEqual([]);
  });

  it("no money path or money directory names it", () => {
    expect(moneyViolations(namers)).toEqual([]);
  });

  it("the invoices service does not read it (it only reaches it through the writer modules)", () => {
    expect(namers).not.toContain("invoices/invoices.service.ts");
    expect(namers).not.toContain("orders/orders.service.ts");
  });

  it("revert-red: a scratch read inside a totals function is detected", () => {
    const scratch = `function editInvoiceTotals(items) { return items.reduce((s, i) => s + i.displayUnitPrice4 * i.qty, 0); }`;
    expect(readsDisplayUnitPrice4(scratch)).toBe(true);
    expect(readsDisplayUnitPrice4(`// displayUnitPrice4 is display only\nconst x = 1;`)).toBe(
      false,
    );
  });
});
