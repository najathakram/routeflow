/**
 * SA-770 (ACTION-ITEMS row 294) — the class pin: "overdue" means a balance is due, so every SQL/ORM
 * reader that selects rows by an OVERDUE CUTOFF (`overdueCutoff(...)`, `dueDate: { lt ... }`,
 * `"dueDate" < ...`) must either go through the one SQL predicate in `invoice-balance-sql.ts` or be
 * listed here with the reason it is already balance-aware / not an invoice reader. A NEW overdue reader
 * that is on neither list fails this spec, instead of re-opening the bug (an overpaid or exactly-paid
 * invoice listed as overdue).
 *
 * Source scan, comments excluded; `*.spec.ts` skipped. Paths are relative to apps/api/src.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const norm = (p: string) => path.relative(SRC_ROOT, p).split(path.sep).join("/");

/** Files that read through the shared predicate — each MUST import `invoice-balance-sql`. */
const USES_SQL_PREDICATE: Record<string, string> = {
  "bookkeeping/bookkeeping.service.ts": "getSummary overdueCount -> overdueInvoiceCount",
  "invoices/overdue-sweep.service.ts":
    "the hourly sweep -> markInvoicesOverdue / overdueInvoiceCount",
  // The list's status + due-day clauses are only the first stage: `applyOverdueBalanceFilter`
  // (called by InvoicesService.findAll) adds `id IN overdueInvoiceIds(...)`.
  "invoices/invoice-list-query.ts":
    "the list filter -> applyOverdueBalanceFilter -> overdueInvoiceIds",
};

/** Files that select by an overdue cutoff but are NOT a raw invoice-status reader, or already net the balance. */
const OTHER_READERS: Record<string, string> = {
  "common/calendar-date.ts": "defines overdueCutoff / isOverdue (the date rule itself)",
  "invoices/invoice-kpi-summary.ts":
    "reads every open invoice with its payments and nets the CONFIRMED balance per row (balance 0 adds 0)",
  "platform-admin/rf-invoices.service.ts":
    "RouteFlow's own platform invoices (a different table, RfInvoice); not tenant AR",
  "invoices/invoice-balance-sql.ts": "the predicate itself",
};

const CUTOFF_READER = [
  /\boverdueCutoff\s*\(/,
  /\bdueDate["']?\s*[:=]\s*\{\s*lte?\b/,
  /["']dueDate["']\s*<=?\s/,
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("SA-770 — every overdue-cutoff reader is balance-aware or accounted for", () => {
  const readers = walk(SRC_ROOT)
    .filter((f) => {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      return CUTOFF_READER.some((re) => re.test(src));
    })
    .map(norm)
    .sort();

  it("finds the known readers (the scan itself works)", () => {
    expect(readers).toEqual(
      expect.arrayContaining([
        ...Object.keys(USES_SQL_PREDICATE),
        "invoices/invoice-kpi-summary.ts",
      ]),
    );
  });

  it("no overdue-cutoff reader is outside the two lists", () => {
    const known = new Set([...Object.keys(USES_SQL_PREDICATE), ...Object.keys(OTHER_READERS)]);
    const unknown = readers.filter((f) => !known.has(f));
    expect(unknown).toEqual([]); // route it through invoice-balance-sql.ts, or list it with a reason
  });

  it.each(Object.keys(USES_SQL_PREDICATE))("%s imports the shared SQL predicate", (rel) => {
    const src = stripComments(fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"));
    expect(src).toMatch(
      /from\s+["'](\.\.?\/)+(invoices\/)?invoice-balance-sql["']|from\s+["']\.\/invoice-balance-sql["']/,
    );
  });

  it("InvoicesService.findAll runs the balance stage after the status filter", () => {
    const src = stripComments(
      fs.readFileSync(path.join(SRC_ROOT, "invoices/invoices.service.ts"), "utf8"),
    );
    const status = src.indexOf("applyInvoiceStatusFilters(where, query, tz)");
    const balance = src.indexOf("applyOverdueBalanceFilter(where, query");
    expect(status).toBeGreaterThan(-1);
    expect(balance).toBeGreaterThan(status);
  });
});
