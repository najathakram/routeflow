/**
 * SA-1208 D1 (M1-02) pins on the read-only receipt (cross.md red test 6, Red team H4):
 *  1. NO WRITER reads the group: only the one-payment read (payment-list-query.ts) imports payment-receipt-group.
 *  2. Void and bounce stay PER ROW: the two writers that set a payment VOID address one row by the function's own
 *     `paymentId`, never by group, never by an `in` list, never by an id read off a group sibling (M1 of #4406).
 *     A third file that sets a payment VOID fails the inventory until its grain is ruled.
 *  4. Two routes put a payment in front of a person (M2 of #4406): the staff receipt read (payment-list-query.ts, the
 *     only reader importer) and the buyer list (buyer/buyer.controller.ts). The buyer route is a NAMED exception,
 *     not a silent gap: it reads the rows itself, shows no receipt, and is owned by M1-04. The exception exists IF
 *     AND ONLY IF the controller still reads `invoicePayment` rows directly (SA-1228 A: structural, no clock, no
 *     date). A new controller that reads `invoicePayment` directly fails until it is named here.
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

/** Controllers that read `invoicePayment` rows themselves (not through a service): dot or bracket access (SA-1235 B3-3). */
export const controllerReadsPayments = (text: string): boolean =>
  /(?:\binvoicePayment|\[\s*["']invoicePayment["']\s*\])\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy)\s*\(/.test(
    codeOnly(text),
  );

/** Nested `payments: {` selects inside another model's read (an invoice include, a customer select). */
export const nestedPaymentSelects = (text: string): number =>
  (codeOnly(text).match(/\bpayments\s*:\s*(\{|true\b)/g) ?? []).length;

/**
 * The deliberate nested reads, each named with a reason (SA-1235 B3-3): counted on purpose, never silently skipped. A new
 * nested `payments:` select in a controller fails until it is added here with its reason. M1-04 owns whether the buyer one moves.
 */
export const NESTED_PAYMENT_SELECTS: { file: string; count: number; reason: string }[] = [
  {
    file: "buyer/buyer.controller.ts",
    count: 1,
    reason: "balance roll-up inside an invoice read, not a receipt list",
  },
];

/**
 * The one named exception to "the staff receipt read is the only route": the buyer list. It exists if and only if the
 * buyer controller still reads `invoicePayment` rows itself; set it to null once M1-04 routes the buyer through the reader.
 */
export const BUYER_ROUTE_EXCEPTION: { file: string; owner: string; reason: string } | null = {
  file: "buyer/buyer.controller.ts",
  owner: "M1-04",
  reason: "buyer list reads rows itself and shows no receipt; the buyer receipt is M1-04",
};

/** A till predicate in the receipt file: membership is `receiptKeyOf` alone (SA-1220). */
export const usesTillPredicate = (text: string): boolean =>
  /\b(isCounterTenderRow|isCounterTenderGroup)\b/.test(codeOnly(text));

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
    const importers = files.filter((f) => importsReceiptReader(f.text)).map((f) => f.file);
    expect(importers).toEqual(["invoices/payment-list-query.ts"]);
    const controllers = files
      .filter((f) => f.file.endsWith(".controller.ts") && controllerReadsPayments(f.text))
      .map((f) => f.file)
      .sort();
    expect(controllers).toEqual(
      [...(BUYER_ROUTE_EXCEPTION ? [BUYER_ROUTE_EXCEPTION.file] : []), FILE_AUTH_READ].sort(),
    );
  });

  it("R11. the buyer exception exists if and only if the buyer controller still reads payment rows (no clock)", () => {
    const buyer = files.find((f) => f.file === "buyer/buyer.controller.ts")!;
    expect(buyer).toBeDefined();
    expect(controllerReadsPayments(buyer.text)).toBe(BUYER_ROUTE_EXCEPTION !== null);
    if (BUYER_ROUTE_EXCEPTION) {
      expect(BUYER_ROUTE_EXCEPTION.owner).toBe("M1-04");
      expect(BUYER_ROUTE_EXCEPTION.file).toBe(buyer.file);
    }
    // the exception cannot quietly become a second reader: once the buyer route imports the reader, delete the exception
    expect(importsReceiptReader(buyer.text)).toBe(false);
  });

  it("R10. the receipt file imports no till predicate (a till rule never decides membership again)", () => {
    expect(usesTillPredicate('import { isCounterTenderRow } from "../orders/x";')).toBe(true);
    expect(usesTillPredicate("// isCounterTenderGroup")).toBe(false);
    const reader = files.find((f) => f.file === "invoices/payment-receipt-group.ts")!;
    expect(usesTillPredicate(reader.text)).toBe(false);
  });

  it("the controller detector flags a planted direct read and ignores a comment", () => {
    expect(controllerReadsPayments("const r = await db.invoicePayment.findMany({ where });")).toBe(
      true,
    );
    expect(controllerReadsPayments("// db.invoicePayment.findMany(")).toBe(false);
    expect(controllerReadsPayments("return this.service.list();")).toBe(false);
  });

  it("the controller detector also flags bracket access, aggregate and groupBy (SA-1235 B3-3)", () => {
    expect(controllerReadsPayments('await db["invoicePayment"].findMany({ where });')).toBe(true);
    expect(controllerReadsPayments("await db.invoicePayment.aggregate({ _sum });")).toBe(true);
    expect(controllerReadsPayments("await db.invoicePayment.groupBy({ by });")).toBe(true);
    expect(controllerReadsPayments('// db["invoicePayment"].findMany(')).toBe(false);
    expect(controllerReadsPayments("await db.invoice.findMany({ where });")).toBe(false);
  });

  it("nested payments selects in controllers are exactly the named list (counted on purpose, SA-1235 B3-3)", () => {
    expect(nestedPaymentSelects("select: { payments: { where, select: { amount: true } } }")).toBe(
      1,
    );
    expect(nestedPaymentSelects("include: { payments: true }")).toBe(1); // M1 of #4454: a bare include is a read too
    expect(nestedPaymentSelects("include: { payments: false }")).toBe(0);
    expect(nestedPaymentSelects("// payments: { a: 1 }")).toBe(0);
    expect(nestedPaymentSelects("constructor(private readonly payments: Svc) {}")).toBe(0);
    for (const n of NESTED_PAYMENT_SELECTS) expect(n.reason.length).toBeGreaterThan(10);
    const found = files
      .filter((f) => f.file.endsWith(".controller.ts") && nestedPaymentSelects(f.text) > 0)
      .map((f) => ({ file: f.file, count: nestedPaymentSelects(f.text) }))
      .sort((a, b) => a.file.localeCompare(b.file));
    expect(found).toEqual(
      NESTED_PAYMENT_SELECTS.map(({ file, count }) => ({ file, count })).sort((a, b) =>
        a.file.localeCompare(b.file),
      ),
    );
  });

  it("the SA-749r2 split-leg namespace is not declared yet (it needs a grain ruling first)", () => {
    expect(files.filter((f) => declaresSplitLegNamespace(f.text)).map((f) => f.file)).toEqual([]);
  });
});
