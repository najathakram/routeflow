/**
 * SA-1208 D1 (M1-02) pins on the read-only receipt (cross.md red test 6, Red team H4):
 *  1. NO WRITER reads the group: only the one-payment read (payment-list-query.ts) imports payment-receipt-group.
 *  2. Void and bounce stay PER ROW: the two writers that set a payment VOID address one row by the function's own
 *     `paymentId`, never by group, never by an `in` list, never by an id read off a group sibling (M1 of #4406).
 *     A third file that sets a payment VOID fails the inventory until its grain is ruled.
 *  4. Two routes put a payment in front of a person (M2 of #4406): the staff receipt read (payment-list-query.ts, the
 *     only reader importer) and the buyer list (buyer/buyer.controller.ts). The buyer route is a NAMED, DATED
 *     exception, not a silent gap: it reads the rows itself, shows no receipt, and is owned by M1-04 (demo window
 *     by 2026-11-25). A new controller that reads `invoicePayment` directly fails until it is named here.
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

/** Every `invoicePayment.update`/`updateMany` call whose `data` sets status VOID. */
export function voidWrites(file: string, text: string) {
  return findCalls(file, text, /\binvoicePayment\s*\.\s*(update|updateMany)\s*\(/).filter((c) =>
    /\bdata\s*:\s*\{[^{}]*\bstatus\s*:\s*["']VOID["']/.test(c.args),
  );
}

/**
 * True when a VOID write addresses exactly one row by the caller's own `paymentId`: `where: { id: paymentId ... }`,
 * with no `in` list, no group id, and no sibling read earlier in the same function that could hand it another id.
 */
export function addressedByOwnId(call: { args: string; scope: string }): boolean {
  const where = /\bwhere\s*:\s*\{\s*id\s*:\s*paymentId\s*[,}]/.test(call.args);
  const fanOut =
    /\bpaymentGroupId\b|\bin\s*:/.test(call.args) ||
    /\bpaymentGroupId\b|\binvoicePayment\s*\.\s*findMany\b/.test(call.scope);
  return where && !fanOut;
}

/** Controllers that read `invoicePayment` rows themselves (not through a service). */
export const controllerReadsPayments = (text: string): boolean =>
  /\binvoicePayment\s*\.\s*(findMany|findFirst|findUnique|count)\s*\(/.test(codeOnly(text));

/** The one named, dated exception to "the staff receipt read is the only route": the buyer list. */
export const BUYER_ROUTE_EXCEPTION = {
  file: "buyer/buyer.controller.ts",
  owner: "M1-04",
  expires: "2026-11-25",
  reason: "buyer list reads rows itself and shows no receipt; the buyer receipt is M1-04",
};
/** Reads one row to authorise a file download; it never shows the payment. */
const FILE_AUTH_READ = "uploads/uploads.controller.ts";

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

  it("the VOID-writer detectors flag a planted fan-out and pass the real shape", () => {
    const wrap = (body: string) => `async voidIt(tx: any, paymentId: string) {
${body}
}`;
    const calls = (body: string) => voidWrites("x", wrap(body));
    const own =
      'await tx.invoicePayment.update({ where: { id: paymentId }, data: { status: "VOID" } });';
    expect(calls(own)).toHaveLength(1);
    expect(addressedByOwnId(calls(own)[0])).toBe(true);
    // not a VOID write: an edit of the same table
    expect(
      calls("await tx.invoicePayment.update({ where: { id: paymentId }, data: { amount: 1 } });"),
    ).toHaveLength(0);
    // a group where
    expect(
      addressedByOwnId(
        calls(
          'await tx.invoicePayment.updateMany({ where: { paymentGroupId: g }, data: { status: "VOID" } });',
        )[0],
      ),
    ).toBe(false);
    // an in-list
    expect(
      addressedByOwnId(
        calls(
          'await tx.invoicePayment.updateMany({ where: { id: { in: ids } }, data: { status: "VOID" } });',
        )[0],
      ),
    ).toBe(false);
    // a sibling id off a loop variable
    expect(
      addressedByOwnId(
        calls(
          'for (const s of sibs) await tx.invoicePayment.update({ where: { id: s.id }, data: { status: "VOID" } });',
        )[0],
      ),
    ).toBe(false);
    // the two-step fan-out: read the group, then void by the caller's id inside the same function
    expect(
      addressedByOwnId(
        calls(
          "const sibs = await tx.invoicePayment.findMany({ where: { paymentGroupId: g } });\n" +
            own,
        )[0],
      ),
    ).toBe(false);
  });

  it("only two files set a payment VOID, and each does it for one row by its own paymentId", () => {
    const writes = files.flatMap((f) => voidWrites(f.file, f.text));
    expect(writes.map((c) => c.file).sort()).toEqual([
      "invoices/invoices.service.ts",
      "invoices/payment-void-tx.ts",
    ]);
    expect(writes.filter((c) => !addressedByOwnId(c)).map((c) => `${c.file}:${c.line}`)).toEqual(
      [],
    );
  });

  it("two routes put a payment in front of a person: the staff receipt read and the named buyer exception", () => {
    expect(BUYER_ROUTE_EXCEPTION.owner).toBe("M1-04");
    const importers = files.filter((f) => importsReceiptReader(f.text)).map((f) => f.file);
    expect(importers).toEqual(["invoices/payment-list-query.ts"]);
    const controllers = files
      .filter((f) => f.file.endsWith(".controller.ts") && controllerReadsPayments(f.text))
      .map((f) => f.file)
      .sort();
    expect(controllers).toEqual([BUYER_ROUTE_EXCEPTION.file, FILE_AUTH_READ].sort());
    // the exception cannot quietly become a second reader: once the buyer route imports the reader, delete the exception
    const buyer = files.find((f) => f.file === BUYER_ROUTE_EXCEPTION.file)!;
    expect(importsReceiptReader(buyer.text)).toBe(false);
  });

  it("the controller detector flags a planted direct read and ignores a comment", () => {
    expect(controllerReadsPayments("const r = await db.invoicePayment.findMany({ where });")).toBe(
      true,
    );
    expect(controllerReadsPayments("// db.invoicePayment.findMany(")).toBe(false);
    expect(controllerReadsPayments("return this.service.list();")).toBe(false);
  });

  it("the SA-749r2 split-leg namespace is not declared yet (it needs a grain ruling first)", () => {
    expect(files.filter((f) => declaresSplitLegNamespace(f.text)).map((f) => f.file)).toEqual([]);
  });
});
