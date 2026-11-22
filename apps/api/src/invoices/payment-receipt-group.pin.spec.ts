/**
 * SA-1208 D1 (M1-02) pins on the read-only receipt (cross.md red test 6, Red team H4):
 *  1. NO WRITER reads the group: only the one-payment read (payment-list-query.ts) imports payment-receipt-group.
 *  2. Void and bounce stay PER ROW: the two writers that set a payment VOID address one row by `id`, never by group.
 *  3. The SA-749r2 split-leg namespace is not on this base. When `COUNTER_TENDER_NS` lands, this fails until
 *     `isSplitLegGroup` knows it and the grain is ruled (so no backfill freezes the wrong grain).
 * Comments are blanked, each detector has a self-test, and an empty scan fails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly, collectSourceFiles, findCalls } from "../testing/source-scan";

const rel = (f: string) => path.relative(API_SRC_ROOT, f).replace(/\\/g, "/");

export const importsReceiptReader = (text: string): boolean =>
  /from\s*["'][^"']*payment-receipt-group["']/.test(codeOnly(text));

export const declaresSplitLegNamespace = (text: string): boolean =>
  /\b(?:const|let|var)\s+COUNTER_TENDER_NS\b/.test(codeOnly(text));

/** True when an `invoicePayment` update that sets VOID addresses rows through the group id (payment-image.ts keys an image by group; that is not a void). */
export function updatesByGroup(text: string): boolean {
  return findCalls("x", text, /\binvoicePayment\s*\.\s*(update|updateMany)\s*\(/).some(
    (c) => /paymentGroupId/.test(c.args) && /VOID/.test(c.args),
  );
}

const files = collectSourceFiles().map((f) => ({ file: rel(f), text: fs.readFileSync(f, "utf8") }));

describe("SA-1208 M1-02: the receipt reader is read-only", () => {
  it("the scan sees the source tree (an empty scan must not report green)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.file === "invoices/payment-receipt-group.ts")).toBe(true);
  });

  it("the detectors flag a planted use and ignore a comment", () => {
    expect(
      importsReceiptReader('import { readReceiptGroup } from "./payment-receipt-group";'),
    ).toBe(true);
    expect(importsReceiptReader('// from "./payment-receipt-group"')).toBe(false);
    expect(declaresSplitLegNamespace('export const COUNTER_TENDER_NS = "x";')).toBe(true);
    expect(declaresSplitLegNamespace("// const COUNTER_TENDER_NS = 1")).toBe(false);
    expect(
      updatesByGroup(
        'async f(tx: any) {\n  await tx.invoicePayment.updateMany({ where: { paymentGroupId: g }, data: { status: "VOID" } });\n}',
      ),
    ).toBe(true);
    expect(
      updatesByGroup(
        "async f(tx: any) {\n  await tx.invoicePayment.update({ where: { id }, data: {} });\n}",
      ),
    ).toBe(false);
  });

  it("only the one-payment read imports the reader: no writer reads the group", () => {
    const importers = files.filter((f) => importsReceiptReader(f.text)).map((f) => f.file);
    expect(importers).toEqual(["invoices/payment-list-query.ts"]);
  });

  it("void and bounce stay per row: no VOID write is addressed by the group id", () => {
    const writers = files.filter((f) =>
      /invoicePayment\s*\.\s*update(Many)?\s*\(/.test(codeOnly(f.text)),
    );
    expect(writers.map((f) => f.file)).toEqual(
      expect.arrayContaining(["invoices/payment-void-tx.ts", "invoices/invoices.service.ts"]),
    );
    expect(writers.filter((f) => updatesByGroup(f.text)).map((f) => f.file)).toEqual([]);
  });

  it("the SA-749r2 split-leg namespace is not declared yet (it needs a grain ruling first)", () => {
    expect(files.filter((f) => declaresSplitLegNamespace(f.text)).map((f) => f.file)).toEqual([]);
  });
});
