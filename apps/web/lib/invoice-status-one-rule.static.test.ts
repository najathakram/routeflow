import * as fs from "fs";
import * as path from "path";
import { INVOICE_STATUS_VALUES } from "@routeflow/types";

/**
 * W-1470 (S-7), shrink-only: an invoice status keyed to a colour class or a Badge variant lives in ONE web file,
 * `lib/invoice-status-display.tsx`. `invoices/[id]/page.tsx` is the one listed exception until the detail-page PR removes
 * it (do not add to this list; take from it). The invoices list no longer holds its own status renderer or the browser-day
 * `calendarDaysUntil`.
 */
const WEB = path.resolve(__dirname, "..");
const ONE_FILE = "lib/invoice-status-display.tsx";
/** Shrink-only: PR-2 deletes this entry. */
const LISTED_EXCEPTIONS = new Set<string>(["app/(dashboard)/invoices/[id]/page.tsx"]);
/** An invoice status key whose value (a string, or an object's first string) holds a text, bg or border colour class. */
const STATUS_WORDS = new RegExp(
  `\\b(${INVOICE_STATUS_VALUES.join("|")})\\b\\s*:\\s*\\{?[^"'\`\\n]{0,20}["'\`][^"'\`]*\\b(text|bg|border)-`,
);

/** The ledger's transaction statuses (UNPAID, PAID, PARTIAL) are a different status, not an invoice's. */
const withoutLedgerTx = (src: string) =>
  src.replace(/const TX_STATUS_COLORS[^=]*=\s*\{[^}]*\};/, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("one invoice status rule (S-7)", () => {
  it("no other file keys an invoice status to a colour class", () => {
    const hits: string[] = [];
    for (const root of ["app", "lib"]) {
      for (const file of walk(path.join(WEB, root))) {
        const rel = path.relative(WEB, file).split(path.sep).join("/");
        if (rel === ONE_FILE || LISTED_EXCEPTIONS.has(rel)) continue;
        if (STATUS_WORDS.test(withoutLedgerTx(fs.readFileSync(file, "utf8")))) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no other file keys the invoice statuses to a Badge variant by hand", () => {
    const hits: string[] = [];
    const byHand =
      /case\s+"(SENT|VIEWED|WRITTEN_OFF)":[\s\S]{0,80}return\s+"(success|warning|danger|info|neutral)"/;
    for (const root of ["app", "lib"]) {
      for (const file of walk(path.join(WEB, root))) {
        const rel = path.relative(WEB, file).split(path.sep).join("/");
        if (rel === ONE_FILE || LISTED_EXCEPTIONS.has(rel)) continue;
        if (byHand.test(fs.readFileSync(file, "utf8"))) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the exception list only names a file that still needs it", () => {
    for (const rel of LISTED_EXCEPTIONS) {
      expect(STATUS_WORDS.test(fs.readFileSync(path.join(WEB, rel), "utf8"))).toBe(true);
    }
  });

  it("the invoices list has no status renderer of its own and no browser-day count", () => {
    const src = fs.readFileSync(path.join(WEB, "app/(dashboard)/invoices/page.tsx"), "utf8");
    expect(src).not.toMatch(/function renderStatus\b/);
    expect(src).not.toMatch(/calendarDaysUntil/);
  });
});
