/**
 * SA-1050 A-1 (G4, OP-7) — repo-truth pin: every hard delete of an Invoice row is classed.
 *
 * `InvoiceWriteOffEvent.invoice` is ON DELETE RESTRICT (the events are the bad-debt ledger), so a delete site that
 * ignores the events dies as a raw P2003. Exactly these files delete Invoice rows (predicate: a non-comment line with
 * `invoice.delete(` or `invoice.deleteMany(` under `apps/api/{src,scripts}`, non-spec), each with a class:
 *   - WIPE        deletes the events of the invoices it deletes, FIRST (the file also contains `invoiceWriteOffEvent.deleteMany`);
 *   - REFUSE      refuses an invoice that has history (the file calls `assertNoWriteOffHistory(`);
 *   - DRAFT_ONLY  deletes DRAFT invoices only (`CUSTOMER_DELETE_NON_BLOCKING` is [DRAFT]); a DRAFT never carries an
 *                 event, and RESTRICT is its backstop.
 * A NEW delete site fails here until it is classed.
 *
 * Runs in the repo-truth lane (`jest -c jest.repo-truth.config.js`).
 */
import * as fs from "fs";
import * as path from "path";
import { INVOICE_DELETE_SITE_CLASSES } from "./invoice-delete-site-classes";
import { CUSTOMER_DELETE_NON_BLOCKING } from "./invoice-status-sets";

const API_ROOT = path.resolve(__dirname, "..", "..");
const SCAN_ROOTS = ["src", "scripts"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const PREDICATE = /\binvoice\.(delete|deleteMany)\(/;

const CLASSES = INVOICE_DELETE_SITE_CLASSES;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name) && !/\.spec\.[tj]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Offset of the first non-comment line carrying the predicate, or -1 (a doc comment that names the call is not a site). */
function firstSiteOffset(text: string): number {
  let offset = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    const comment = t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
    if (!comment && PREDICATE.test(line)) return offset + line.search(PREDICATE);
    offset += line.length + 1;
  }
  return -1;
}

const read = (rel: string) => fs.readFileSync(path.join(API_ROOT, rel), "utf8");

describe("SA-1050 A-1: every Invoice delete site is classed (repo truth)", () => {
  const sites = SCAN_ROOTS.flatMap((root) => walk(path.join(API_ROOT, root)))
    .filter((file) => firstSiteOffset(fs.readFileSync(file, "utf8")) >= 0)
    .map((file) => path.relative(API_ROOT, file).split(path.sep).join("/"))
    .sort();

  it("exactly the classed files delete Invoice rows (a new site fails until it is classed)", () => {
    expect(sites).toEqual(Object.keys(CLASSES).sort());
    expect(sites).toHaveLength(8);
  });

  it.each(Object.entries(CLASSES).filter(([, cls]) => cls === "WIPE"))(
    "WIPE %s also deletes the events first (contains invoiceWriteOffEvent.deleteMany)",
    (rel) => {
      const text = read(rel);
      expect(text).toContain("invoiceWriteOffEvent.deleteMany");
      // FIRST: the events go before the invoices they point at (RESTRICT).
      expect(text.indexOf("invoiceWriteOffEvent.deleteMany")).toBeLessThan(firstSiteOffset(text));
    },
  );

  it.each(Object.entries(CLASSES).filter(([, cls]) => cls === "REFUSE"))(
    "REFUSE %s calls assertNoWriteOffHistory(",
    (rel) => {
      const text = read(rel);
      expect(text).toContain("assertNoWriteOffHistory(");
      expect(text.indexOf("assertNoWriteOffHistory(")).toBeLessThan(firstSiteOffset(text));
    },
  );

  it("DRAFT_ONLY deletes only the non-blocking statuses, and those are exactly [DRAFT]", () => {
    expect(CUSTOMER_DELETE_NON_BLOCKING).toEqual(["DRAFT"]);
    const text = read("src/customers/customer-delete-preflight.ts");
    expect(text).toMatch(
      /invoice\.deleteMany\([^)]*status:\s*\{\s*notIn:\s*CUSTOMER_DELETE_BLOCKING/,
    );
  });
});
