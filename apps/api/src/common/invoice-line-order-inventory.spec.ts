import * as fs from "fs";
import * as path from "path";

/**
 * SA-1058 MUST 2: the inventory of every API file that takes lines off an invoice object. A person sees
 * invoice lines in ONE order (`sortInvoiceLines`), so a file that reads them is either a copy a person
 * sees, which calls the helper, or it has a stated reason. A new file reading `inv.items` turns this
 * red until it is placed here on purpose.
 *
 * Source pin, comments ignored. The call sites run for real in invoice-line-order.db.spec.ts.
 */

const SRC = path.resolve(__dirname, "..");
const READS_LINES = /\b(?:inv|invoice|snapshot)\??\.items\b/;

/** The copies a person reads. Each calls the helper; the number is how many times. */
const SHOWN: Record<string, number> = {
  "invoices/invoice-pdf.service.ts": 1, // the PDF and every emailed copy of it
  "invoices/invoice-email-payload.ts": 2, // the send email's table and the reminder's
};

/** Reads lines, shows no list of its own. */
const NOT_SHOWN: Record<string, string> = {
  "analytics/analytics.service.ts": "sums",
  "bookkeeping/bookkeeping.service.ts": "posts journal lines",
  "common/invoiced-sales.ts": "sums",
  "common/staff-only-fields.ts": "projects the array it receives, in order",
  "credit-notes/credit-notes.service.ts":
    "headroom spreads in [createdAt, id]: money, never re-sort",
  "credit-notes/line-credit-headroom.ts": "headroom, as above",
  "customers/customer-price-history.service.ts": "keyed by product",
  "estimates/estimates.service.ts": "matches lines for a conversion",
  "invoices/invoice-display-unit.ts": "maps the array it receives, in order",
  "invoices/invoice-pdf-template.tsx": "renders the array the PDF service hands it",
  "invoices/invoices.service.ts": "writers and guards; findOne is pinned below",
  "invoices/nsf-line.ts": "a comment names the read",
  "invoices/order-backsync-aggregate.ts": "sums",
  "invoices/partial-price-follow.ts": "reprices by line id",
  "invoices/price-adjustment-ledger.ts": "ledger lines by id",
  "invoices/split-invoice-retry.ts": "a comment names the read",
  "orders/open-order-lines.ts": "sums",
  "returns/inline-returns-quote.service.ts": "matches lines for a return",
  "returns/returns.service.ts": "headroom",
  "returns/standard-refund-pricing.ts": "prices a return",
  "sales-agents/commission-engine.service.ts": "commission sums",
  "sales-facts/sales-facts.service.ts": "facts, sorted by its own byLineDesc",
};

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, "$1");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "testing" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const relative = (full: string) => path.relative(SRC, full).split(path.sep).join("/");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const calls = (src: string) => (stripComments(src).match(/\bsortInvoiceLines\(/g) ?? []).length;

describe("invoice line order inventory (SA-1058)", () => {
  const readers = sourceFiles(SRC)
    .filter((f) => READS_LINES.test(fs.readFileSync(f, "utf8")))
    .map(relative)
    .sort();

  it("every file that reads an invoice's lines is placed: a shown copy or a stated reason", () => {
    expect(readers).toEqual([...Object.keys(SHOWN), ...Object.keys(NOT_SHOWN)].sort());
  });

  it.each(Object.entries(SHOWN))("%s calls the helper %i time(s)", (file, count) => {
    expect(calls(read(file))).toBe(count);
  });

  it("findOne, the screen and the buyer's copy, returns the helper's order", () => {
    const src = stripComments(read("invoices/invoices.service.ts"));
    const start = src.indexOf("async findOne(id: string, user?: JwtPayload)");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    expect(calls(body)).toBe(1);
  });

  it("nothing sorts an invoice's own items array: the send fingerprint hashes it in array order", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) =>
        /\b(?:inv|invoice|snapshot|model)\??\.items\??\.(?:sort|reverse)\(/.test(
          fs.readFileSync(f, "utf8"),
        ),
      )
      .map(relative);
    expect(offenders).toEqual([]);
  });
});
