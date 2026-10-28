import * as fs from "fs";
import * as path from "path";

/**
 * SA-795 fold G1 (T17c): the invoice unit is DISPLAY ONLY. `invoiceLineDisplay` (packages/pricing/src/invoice-display.ts)
 * turns a stored line into "72 Pieces at $0.7875"; that 4-decimal price must never feed money. Line totals, tax, payments and
 * the ledger use the stored line amount, and a credit note computes in the unit sold through `creditedThrough`.
 *
 * Source pin: none of the money writers below, and no money module of the pricing package, may name the display math or
 * the invoice-unit snapshot fields. Comments are ignored.
 */

const REPO = path.resolve(__dirname, "../../../..");
const FORBIDDEN =
  /\b(?:invoiceUnitFactor|invoiceUnitLabel|invoiceLineDisplay|InvoiceLineDisplay|invoiceDisplayLines|InvoiceDisplayLines|invoiceDisplayUnitFor|displayUnitSnapshotOf|displayUnitForItem|perBaseUnitPrice|PerBaseUnit)\b/;

/**
 * SA-827 (I6): the CALLER names. The display helpers (live resolve, issue-time resolve/write/clear, the item decorator) may be
 * called only from the two services that own the DRAFT -> issued transition, plus the display files. A new caller is a new
 * place that decides when a snapshot is written, so it must be added here on purpose.
 */
const CALLER =
  /\b(?:resolveLiveDisplayUnits|withItemDisplayUnits|resolveDraftIssueUnits|itemsWithDisplayUnits|resolveIssueDisplayUnits|writeIssueDisplayUnits|writeIssueBaseLabels|freezeDraftIssueUnits|freezeIssueUnitsFromCatalog|loadStopDisplayUnitCatalog|clearIssueDisplayUnits|displayUnit)\b/;
const CALLER_FILES = [
  "apps/api/src/invoices/invoices.service.ts",
  "apps/api/src/bookkeeping/bookkeeping.service.ts",
];

/** Directories whose non-spec source writes or computes money. */
const MONEY_DIRS = [
  "apps/api/src/invoices",
  "apps/api/src/orders",
  "apps/api/src/estimates",
  "apps/api/src/recurring-invoices",
  "apps/api/src/credit-notes",
  "apps/api/src/bookkeeping",
  "apps/api/src/payment-requests",
  "apps/api/src/stripe-connect",
  "apps/api/src/returns",
  "apps/api/src/vendor-bills",
  "apps/api/src/regulated",
  "packages/pricing/src",
];
/** Single money files outside those directories. */
const MONEY_FILES = ["apps/api/src/common/invoiced-sales.ts"];
/** The pricing files that legitimately hold the display math. */
const DISPLAY_FILES = new Set([
  "packages/pricing/src/invoice-display.ts",
  "packages/pricing/src/invoice-display-lines.ts",
  "packages/pricing/src/per-base-unit.ts",
  "packages/pricing/src/index.ts",
]);
/** The API files that render an invoice (display only), by exact name: the PDF modules and the detail read. A new file must be added here on purpose. */
const DISPLAY_API_FILES = [
  "invoice-pdf-item.ts",
  "invoice-pdf-pointer.ts",
  "invoice-pdf-template.tsx",
  "invoice-pdf-terms.ts",
  "invoice-pdf-variant.ts",
  "invoice-pdf.service.ts",
  "invoice-detail-read.ts",
  "invoice-display-unit.ts",
  "invoice-email-payload.ts",
].map((n) => `apps/api/src/invoices/${n}`);
const isDisplay = (f: string): boolean => DISPLAY_FILES.has(f) || DISPLAY_API_FILES.includes(f);

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)) out.push(p);
  }
}

describe("G1: the invoice unit never reaches a money writer", () => {
  const files: string[] = [];
  for (const d of MONEY_DIRS) walk(path.join(REPO, d), files);
  for (const f of MONEY_FILES) files.push(path.join(REPO, f));
  const rel = files.map((f) => path.relative(REPO, f).split(path.sep).join("/"));

  it("scans a real set of money files", () => {
    expect(rel.length).toBeGreaterThan(40);
    expect(rel).toEqual(
      expect.arrayContaining([
        "apps/api/src/credit-notes/credit-notes.service.ts",
        "apps/api/src/invoices/nsf-line-tax-guard.ts",
        "apps/api/src/invoices/price-adjustment-ledger.ts",
        "apps/api/src/invoices/partial-price-follow.ts",
        "apps/api/src/invoices/counter-payment-guard.ts",
        "apps/api/src/orders/orders.service.ts",
        "apps/api/src/estimates/estimates.service.ts",
        "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
        "apps/api/src/common/invoiced-sales.ts",
      ]),
    );
  });

  it("the detector is not vacuous: it matches a field read and ignores a comment", () => {
    expect(FORBIDDEN.test("const f = x.invoiceUnitFactor;")).toBe(true);
    expect(FORBIDDEN.test(stripComments("// invoiceUnitFactor"))).toBe(false);
    expect(FORBIDDEN.test(stripComments("/* invoiceLineDisplay */"))).toBe(false);
  });

  it("the detector matches each SA-827 display name", () => {
    for (const n of [
      "invoiceDisplayLines",
      "InvoiceDisplayLines",
      "invoiceDisplayUnitFor",
      "displayUnitSnapshotOf",
      "displayUnitForItem",
    ])
      expect(FORBIDDEN.test(`const f = ${n}(x);`)).toBe(true);
  });

  it("the display allow-list covers the PDF modules and the detail read, and nothing else", () => {
    expect(isDisplay("apps/api/src/invoices/invoice-pdf.service.ts")).toBe(true);
    expect(isDisplay("apps/api/src/invoices/invoice-detail-read.ts")).toBe(true);
    expect(isDisplay("apps/api/src/invoices/invoice-display-unit.ts")).toBe(true);
    expect(isDisplay("apps/api/src/invoices/invoices.service.ts")).toBe(false);
    expect(isDisplay("apps/api/src/invoices/invoice-pdf-new-money.ts")).toBe(false);
    expect(isDisplay("apps/api/src/invoices/price-adjustment-ledger.ts")).toBe(false);
  });

  it("no money module names the display math or the snapshot fields", () => {
    const offenders = rel
      .filter((f) => !isDisplay(f))
      .filter((f) => FORBIDDEN.test(stripComments(fs.readFileSync(path.join(REPO, f), "utf8"))));
    expect(offenders).toEqual([]);
  });

  const read = (f: string): string => stripComments(fs.readFileSync(path.join(REPO, f), "utf8"));

  it("the caller detector is not vacuous: it matches each display helper and ignores a comment", () => {
    for (const n of [
      "resolveLiveDisplayUnits",
      "withItemDisplayUnits",
      "resolveIssueDisplayUnits",
      "writeIssueDisplayUnits",
      "writeIssueBaseLabels",
      "freezeDraftIssueUnits",
      "freezeIssueUnitsFromCatalog",
      "loadStopDisplayUnitCatalog",
      "clearIssueDisplayUnits",
      "displayUnit",
    ])
      expect(CALLER.test(`await ${n}(x);`)).toBe(true);
    expect(CALLER.test(stripComments("// writeIssueDisplayUnits"))).toBe(false);
  });

  it("only the two owning services (and the display files) name a display helper", () => {
    const offenders = rel
      .filter((f) => !isDisplay(f) && !CALLER_FILES.includes(f))
      .filter((f) => CALLER.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the owning services name ONLY the allowed helpers, and write the snapshot from exactly 4 call sites", () => {
    const ALLOWED = new Set([
      "resolveLiveDisplayUnits",
      "withItemDisplayUnits",
      "resolveDraftIssueUnits",
      "itemsWithDisplayUnits",
      "resolveIssueDisplayUnits",
      "writeIssueDisplayUnits",
      "writeIssueBaseLabels",
      "freezeDraftIssueUnits",
      "freezeIssueUnitsFromCatalog",
      "loadStopDisplayUnitCatalog",
      "clearIssueDisplayUnits",
    ]);
    const named = new Set<string>();
    let writeCalls = 0;
    for (const f of CALLER_FILES) {
      const src = read(f);
      for (const m of src.matchAll(new RegExp(CALLER.source, "g"))) named.add(m[0]);
      writeCalls += (
        src.match(
          /\b(?:writeIssueDisplayUnits|freezeDraftIssueUnits|freezeIssueUnitsFromCatalog)\(/g,
        ) ?? []
      ).length;
    }
    expect([...named].filter((n) => !ALLOWED.has(n))).toEqual([]);
    // markSent, the inline flip in createInvoiceFromOrderWithTenant, recordDeliveryPaymentInTx, bookkeeping recordPayment
    expect(writeCalls).toBe(4);
  });
});

/**
 * SA-1029 (G-6): the per-piece price is read from ONE place. On the four invoice surfaces (PDF, email, staff invoice page,
 * buyer portal invoice page) the "per piece" cell comes from `perBaseUnit` (frozen word + `perBaseUnitPrice`), never from a
 * second division or a hard-coded "pc" suffix. Count-pinned: a new occurrence is a new place that prices a piece, so it must
 * be added here on purpose. The pre-existing display helpers (`formatUnitPrice4`, `pieceUnitPriceText`, the MSRP "/pc" suffix)
 * are pinned at their current counts, not zero.
 */
const SURFACES = [
  "apps/api/src/invoices/invoice-pdf-item.ts",
  "apps/api/src/invoices/invoice-pdf-template.tsx",
  "apps/api/src/invoices/invoice-email-payload.ts",
  "apps/api/src/email/email.service.ts",
  "apps/web/app/(dashboard)/invoices/[id]/page.tsx",
  "apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx",
];
const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

describe("G-6: one source for the per-piece price on the invoice surfaces", () => {
  const src = (f: string): string => stripComments(fs.readFileSync(path.join(REPO, f), "utf8"));
  const total = (re: RegExp): number => SURFACES.reduce((n, f) => n + count(src(f), re), 0);

  it("the pattern detectors are not vacuous", () => {
    expect(count("perUnitPrice(x)", /\bperUnitPrice\(/g)).toBe(1);
    expect(count("a.unitPrice / b.unitsPerBox", /unitPrice[^;\n]*\/[^;\n]*unitsPerBox/g)).toBe(1);
    expect(count("x/pc", /\/pc\b/g)).toBe(1);
    expect(count(stripComments("// perUnitPrice("), /\bperUnitPrice\(/g)).toBe(0);
  });

  it("no surface divides a unit price by units-per-box, or calls perUnitPrice(", () => {
    expect(total(/\bperUnitPrice\(/g)).toBe(0);
    expect(total(/unitPrice[^;\n]*\/[^;\n]*unitsPerBox/g)).toBe(0);
  });

  it("the pre-existing price helpers keep their pinned counts (no new caller)", () => {
    expect(total(/\bformatUnitPrice4\(/g)).toBe(2);
    expect(total(/\bpieceUnitPriceText\(/g)).toBe(3);
    expect(total(/\/pc\b/g)).toBe(4);
  });

  it("the new per-piece column is fed by perBaseUnit on every surface", () => {
    for (const f of SURFACES.filter((x) => !x.endsWith("invoice-pdf-item.ts")))
      expect(src(f)).toMatch(/perBaseUnit/);
  });
});
