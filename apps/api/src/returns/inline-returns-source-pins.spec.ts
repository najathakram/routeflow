import fs from "node:fs";
import path from "node:path";

/**
 * #2094 PR-A / SA-221: source pins on the lock discipline of the in-order inline-return path.
 * House lock order: advisory (order-merge -> returns.customer) -> Return -> Order -> Invoice ->
 * rows (SA-214). These services run INSIDE a caller's transaction that already holds the Order
 * row, so none of them may take a session advisory lock, the order-recompute lock, or the tx-less
 * `recomputeOrderFromInvoices` (which opens its own connection and would wait on a row this very
 * transaction holds). Comments are stripped first so prose that names a forbidden call is fine.
 */
const SRC = path.resolve(__dirname, "..");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (rel: string) => stripComments(fs.readFileSync(path.join(SRC, rel), "utf8"));

const FORBIDDEN = ["withAdvisoryLock", "withOrderRecomputeLock", "recomputeOrderFromInvoices"];

describe.each([
  "returns/inline-returns.service.ts",
  "returns/inline-returns-quote.service.ts",
  "credit-notes/credit-notes.service.ts",
])("%s never takes a lock or recompute that could invert the lock order (#2094)", (file) => {
  it.each(FORBIDDEN)("does not call %s", (name) => {
    expect(read(file)).not.toContain(name);
  });
});

describe("the customer advisory lock is only ever the xact lock on the caller's own tx", () => {
  it("captureInTx does not acquire it (the caller does, first, before any row lock)", () => {
    const code = read("returns/inline-returns.service.ts");
    const body = code.slice(
      code.indexOf("async captureInTx("),
      code.indexOf("async captureAndIssueInTx("),
    );
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain("acquireLock");
  });
});

describe("lockCustomerInTx is the transaction-scoped xact lock on the caller's own tx (#2094)", () => {
  const code = read("returns/inline-returns.service.ts");
  const start = code.indexOf("async lockCustomerInTx(");
  const body = code.slice(start, code.indexOf("reserveCreditNoteNumber()", start));

  it("takes the xact lock through IdempotencyService.acquireLock on the caller's tx", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("this.idempotency.acquireLock(");
    expect(body).toContain('"returns.customer"');
  });

  it("never opens a session lock or a transaction of its own", () => {
    for (const forbidden of ["withAdvisoryLock", "tenantTransaction", "$transaction"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
