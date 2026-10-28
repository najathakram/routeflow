import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * SA-1042 A-4 pin G4 (OP-7): `CreditNoteItem.categoryTax` is the levy a typed credit REQUESTED, the figure
 * `reverseCreditNoteEntries` reads as input. The regulated ledger is the one source for "levy reversed": since A-4 binds a
 * typed row to the ledger's remaining, the two differ only by a closing credit's cent drift. A reader that summed the stored
 * field instead of the ledger would re-open that gap, so every non-spec file that touches the item table (`creditNoteItem`
 * / `"CreditNoteItem"`) AND mentions `categoryTax` as a whole word is classed here. An unclassified file fails the build, and
 * so does a classed file that stops matching.
 *  - WRITER: writes the item rows (the one place the requested levy is computed).
 *  - REVERSAL: reads the stored request as the reversal's input, then clamps it to the ledger's remaining.
 *  - NOT_A_READER: mentions both words without reading the stored levy (with the reason).
 *  - OWNER_REPORT: an owner-run, read-only report; it never feeds a filing figure.
 * Known limit: a reader that reaches the field through a relation `include` (no `creditNoteItem` token) escapes this scan.
 */
type LevyReaderClass = "WRITER" | "REVERSAL" | "NOT_A_READER" | "OWNER_REPORT";

const FILES: Record<string, { class: LevyReaderClass; why: string }> = {
  "apps/api/src/credit-notes/credit-notes.service.ts": {
    class: "WRITER",
    why: "insertCreditNoteInTx writes each row's categoryTax (the line's levy x the credited fraction, or a return refund's slice)",
  },
  "apps/api/src/regulated/regulated-ledger.service.ts": {
    class: "REVERSAL",
    why: "reverseCreditNoteEntries reads the item (amount, qty, categoryTax) and books the REVERSAL clamped to credit-reversal-room.ts",
  },
  "apps/api/src/returns/inline-returns-quote.service.ts": {
    class: "NOT_A_READER",
    why: "its creditNoteItem select is invoiceItemId / qty / creditNoteId; the categoryTax there is the quote's own",
  },
  "apps/api/src/credit-notes/line-credit-headroom.ts": {
    class: "NOT_A_READER",
    why: "its creditNoteItem select is invoiceItemId / amount / qty; categoryTax is a field of the priced slice type (SA-840)",
  },
  "apps/api/src/common/testing/copier-contract/copier-registry.ts": {
    class: "NOT_A_READER",
    why: "ReturnItem field lists for the copier contract, not a read of the stored levy",
  },
  "apps/api/scripts/report-standard-refund-tax-shortfall.mjs": {
    class: "OWNER_REPORT",
    why: "SA-840 section 5 owner-run read-only SQL: prior credits' stored levy is the slice already refunded in a pricing comparison",
  },
};

const REPO = join(__dirname, "..", "..", "..", "..");
const ROOTS = ["apps/api/src", "apps/api/scripts", "apps/web", "apps/mobile", "packages", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".expo",
  ".turbo",
  "coverage",
  "build",
  "migrations",
  "__tests__",
  "e2e",
  "test-results",
]);
const SOURCE = /\.(ts|tsx|mjs|cjs|js)$/;
const TEST = /\.(spec|test)\.[cm]?[jt]sx?$/;

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** True when the (comment-stripped) source touches the item table AND names `categoryTax` as a whole word. */
export function touchesItemLevy(source: string): boolean {
  const code = stripComments(source);
  return /\bcreditNoteItem\b|"CreditNoteItem"/.test(code) && /\bcategoryTax\b/.test(code);
}

function sources(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(abs);
    return SOURCE.test(name) && !TEST.test(name) ? [abs] : [];
  });
}

describe("SA-1042 A-4 pin G4: every reader of CreditNoteItem.categoryTax is classed", () => {
  it("the detector flags a planted reader and ignores a comment-only mention (self-test)", () => {
    expect(
      touchesItemLevy("const rows = await db.creditNoteItem.findMany({}); sum(r.categoryTax);"),
    ).toBe(true);
    expect(touchesItemLevy('SELECT "categoryTax" FROM "CreditNoteItem"')).toBe(true);
    expect(touchesItemLevy("// creditNoteItem.categoryTax is documented here\nconst a = 1;")).toBe(
      false,
    );
    expect(touchesItemLevy("db.creditNoteItem.findMany({ select: { amount: true } })")).toBe(false);
    expect(touchesItemLevy("const categoryTaxTotal = 1; creditNoteItem")).toBe(false);
  });

  it("scans a non-empty tree, and every file that touches the item levy is classed (and every classed file still does)", () => {
    const found = ROOTS.flatMap((root) => sources(join(REPO, root)))
      .filter((f) => touchesItemLevy(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f).replace(/\\/g, "/"))
      .sort();
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((f) => !FILES[f])).toEqual([]);
    expect(Object.keys(FILES).filter((f) => !found.includes(f))).toEqual([]);
  });
});
