/**
 * Source-scan pin: EVERY writer that UPDATES or DELETES an `InvoicePayment` row under `apps/api/src` is classified.
 *
 * Sibling of invoice-payment-writers.spec.ts (which pins the CREATE side). A till TENDER row (`isCounterTenderRow`,
 * orders/counter-sale/counter-tender-row.ts: a counter sale's ungrouped CASH / CREDIT_CARD / CHECK row, a pickup order's own
 * hand-over group `pickupTenderGroupId`) dated inside a CLOSED end-of-day window must not be edited, voided or deleted: the stored
 * Z report and a fresh fold of the window would no longer agree. The guard (invoices/counter-payment-guard.ts) takes the SHARED
 * counter-close lock as the transaction's first statement for any scoped invoice (a counter sale OR a PICKUP order) and refuses
 * PER ROW (`counterPay.assertOpen`): only a tender row (stored state, and for an edit its new state) inside a closed window. This
 * spec makes the next new mutator fail the build until somebody reads it and decides which class it is in:
 *
 *  - "till-guarded"  takes the counter close lock and the per-row window check before it writes (directly, or through the
 *                    callers named in `guardedBy`, which this spec requires to still contain their guard calls).
 *  - "non-till"      cannot touch a till tender row: say why (the method is never a till method, the columns written are not
 *                    money / date / state columns, or the write only ever matches rows that cannot be tender).
 *  - "known-gap"     a path that CAN change a closed window's tender row without the guard: say exactly why and which ruling
 *                    covers it, so it stays visible.
 *
 * It fails when (a) a file holds a mutator but is not in the table, (b) a file's mutator count differs from the table, (c) a
 * table file no longer holds a mutator, (d) a row is not fully classified and reasoned, (e) a "till-guarded" file (or one of its
 * `guardedBy` callers) stops calling its guard, (f) the guard itself stops using the one tender predicate and the window read.
 *
 * Counted: `invoicePayment.update | updateMany | delete | deleteMany` on any client/tx (also the chained
 * `.invoicePayment\n.updateMany` form), `deleteMoneyRecordCas(tx.invoicePayment, ...)`, a nested `payments: { update | updateMany |
 * delete | deleteMany | upsert }` relation write, and a raw `UPDATE "InvoicePayment"` / `DELETE FROM "InvoicePayment"`. Comment
 * lines are ignored; `*.spec.ts`, `*.test.ts` and `testing/` helpers are excluded.
 *
 * bookkeeping/bookkeeping.service.ts has a payment CREATE (pinned in invoice-payment-writers.spec.ts) and NO update / delete of a
 * payment; if one is ever added, (a) fails until it is classified here like the invoice paths.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

type MutatorClass = "till-guarded" | "non-till" | "known-gap";

interface Mutator {
  /** Informational: where in the file this writer lives (the nth mutator in source order). */
  where: string;
  class: MutatorClass;
  reason: string;
}

interface Row {
  file: string;
  count: number;
  mutators: Mutator[];
  /** Each must appear in the file when ANY of its mutators is "till-guarded" and the file holds the guard itself. */
  guardMarkers?: string[];
  /** For a "till-guarded" mutator whose guard lives in its callers: file -> marker that must still appear there. */
  guardedBy?: Array<{ file: string; marker: string }>;
}

const TABLE: Row[] = [
  {
    file: "invoices/invoices.service.ts",
    count: 5,
    guardMarkers: [
      "counterPay.lock",
      "counterPay.assertEditDated",
      "counterPay.assertOpen(tx, till, payment)",
      "counterPay.assertPaymentOpen",
    ],
    mutators: [
      {
        where:
          "releaseWalletPaymentsInTx (delete of ADVANCE application rows on an invoice void / order delete)",
        class: "non-till",
        reason:
          "the select is method: ADVANCE with an advancePaymentId, never a till method (the cash was banked when the advance was taken)",
      },
      {
        where: "updatePayment (update)",
        class: "till-guarded",
        reason:
          "counterPay.lock first, then counterPay.assertEditDated, whose first step is the per-row assertOpen on the STORED row and the row's NEW state (tender + closed window = 409 COUNTER_SALE_DAY_CLOSED); the 1b DAY_CLOSED_FOR_PAYMENT_DATE rule follows",
      },
      {
        where: "deletePayment (delete)",
        class: "till-guarded",
        reason:
          "counterPay.lock first, then counterPay.assertOpen on the stored row (per-row rule)",
      },
      {
        where: "setCheckStatus DEPOSITED / CLEARED (update)",
        class: "non-till",
        reason:
          "SA ruling C (accepted, 2026-10-10): a RECORDED check moving to DEPOSITED / CLEARED without the close lock is accepted. It changes grouping only (the CHECK group of a fresh fold: a deposited check is no longer a till tender row), never cash, and never a stored close. invoices.counter-day-close.spec.ts pins that setCheckStatus other than BOUNCED is unchanged",
      },
      {
        where: "setCheckStatus BOUNCED (updateMany compare-and-swap to VOID)",
        class: "till-guarded",
        reason:
          "scope is read for BOUNCED, counterPay.lock first, then counterPay.assertOpen on the stored row (per-row rule)",
      },
    ],
  },
  {
    file: "invoices/payment-void-tx.ts",
    count: 1,
    guardedBy: [
      { file: "invoices/invoices.service.ts", marker: "counterPay.assertPaymentOpen" },
      {
        file: "orders/counter-sale/counter-sale-void.service.ts",
        marker: "counterPay.assertDatesOpen",
      },
    ],
    mutators: [
      {
        where: "voidPaymentInTx (status -> VOID), the one single-payment void writer",
        class: "till-guarded",
        reason:
          "never called bare: voidPayment takes counterPay.lock + assertPaymentOpen (per-row) before it, and the counter-sale void calls it for the counter tender rows only after counterPay.assertDatesOpen under the same shared lock (its only other caller)",
      },
    ],
  },
  {
    file: "invoices/payment-image.ts",
    count: 4,
    mutators: [
      {
        where: "attachPaymentImage (updateMany by group / update by id)",
        class: "non-till",
        reason:
          "writes imageKey / imageOriginalName / imageMimeType only: no amount, method, status, group, check state or date column, so no close total can move",
      },
      {
        where: "attachPaymentImage (update by id, ungrouped row)",
        class: "non-till",
        reason: "same image-metadata-only columns as above",
      },
      {
        where: "deletePaymentImage (updateMany by group, clears the image columns)",
        class: "non-till",
        reason:
          "clears imageKey / imageOriginalName / imageMimeType only; no money, date or state column",
      },
      {
        where: "deletePaymentImage (update by id, ungrouped row)",
        class: "non-till",
        reason: "same image-metadata-only columns as above",
      },
    ],
  },
  {
    file: "orders/orders.service.ts",
    count: 1,
    mutators: [
      {
        where: "deleteOrder cascade (deleteMany of every payment row of the order's invoices)",
        class: "non-till",
        reason:
          "runs only after cancelImpact: a live external payment (PAID / PENDING / DRAFT) on a non-VOID invoice refuses the delete, and voidInvoice refuses live external payments, so what is left to delete is VOID-status rows (not tender: isCounterTenderRow needs PAID / PENDING; the close fold drops a VOID invoice's payments) and ADVANCE / CREDIT_NOTE rows",
      },
    ],
  },
  {
    file: "import/import.service.ts",
    count: 1,
    mutators: [
      {
        where: "payment import (deleteMany of the synthetic reference 'zoho-import' placeholder)",
        class: "non-till",
        reason:
          "deletes only the synthetic zoho-import row (method OTHER) of an imported invoice; imported invoices have no counter-sale or pickup order, so no close window contains them",
      },
    ],
  },
  {
    file: "credit-notes/credit-notes.service.ts",
    count: 4,
    mutators: [
      {
        where: "restoreCreditFromPaymentInTx (delete of a fully restored CREDIT_NOTE application)",
        class: "non-till",
        reason: "the row has a creditNoteId: method CREDIT_NOTE, never a till method",
      },
      {
        where: "restoreCreditFromPaymentInTx (update: amount reduced on a partial restore)",
        class: "non-till",
        reason: "the row has a creditNoteId: method CREDIT_NOTE, never a till method",
      },
      {
        where: "restoreAdvanceFromPaymentInTx (delete of a fully restored ADVANCE application)",
        class: "non-till",
        reason: "the row has an advancePaymentId: method ADVANCE, never a till method",
      },
      {
        where: "restoreAdvanceFromPaymentInTx (update: amount reduced on a partial restore)",
        class: "non-till",
        reason: "the row has an advancePaymentId: method ADVANCE, never a till method",
      },
    ],
  },
  {
    file: "customers/customers.service.ts",
    count: 2,
    mutators: [
      {
        where: "deleteCustomer cascade (deleteMoneyRecordCas on the customer's invoices)",
        class: "non-till",
        reason:
          "a compare-and-set that expects ZERO rows (assertNoMoneyRecords refuses a customer with any InvoicePayment first); a row that appears is a 409 and a rollback, never deleted",
      },
      {
        where: "deleteAllCustomers cascade (deleteMoneyRecordCas on the customers' invoices)",
        class: "non-till",
        reason: "the same zero-row compare-and-set; nothing is ever deleted through it",
      },
    ],
  },
  {
    file: "system-config/settings.controller.ts",
    count: 1,
    mutators: [
      {
        where: "clearFinancialData (deleteMany of every payment of the tenant)",
        class: "non-till",
        reason:
          "TENANT_ADMIN whole-tenant financial wipe behind a typed tenantId confirmation, a dataset reset rather than a payment edit. SA ruling C: it deletes the tenant's CounterDayClose and CounterParkedCart rows in the SAME transaction (settings.controller.clear-financial.spec.ts T2b), so no close outlives the money it summarised",
      },
    ],
  },
];

const MUTATOR_RE =
  /\binvoicePayment\s*\.\s*(update|updateMany|delete|deleteMany)\b|\bdeleteMoneyRecordCas\(\s*tx\.invoicePayment\b|\bpayments\s*:\s*\{\s*(update|updateMany|delete|deleteMany|upsert)\b|\bUPDATE\s+"InvoicePayment"|\bDELETE\s+FROM\s+"InvoicePayment"/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "testing") continue;
      sourceFiles(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Counts mutators on the comment-stripped text, so a chained `.invoicePayment\n  .updateMany(` (split across lines) counts too. */
function countMutators(text: string): number {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return (code.match(MUTATOR_RE) ?? []).length;
}

const read = (file: string) => fs.readFileSync(path.join(SRC_ROOT, file), "utf8");

const found = new Map<string, number>();
for (const file of sourceFiles(SRC_ROOT)) {
  const n = countMutators(fs.readFileSync(file, "utf8"));
  if (n > 0) found.set(path.relative(SRC_ROOT, file).split(path.sep).join("/"), n);
}

describe("InvoicePayment update / delete writers are all classified", () => {
  it("(a) no mutator lives in a file the table does not know: classify it before it ships", () => {
    const known = new Set(TABLE.map((r) => r.file));
    expect([...found.keys()].filter((f) => !known.has(f))).toEqual([]);
  });

  it("(b) every table file holds exactly the pinned number of mutators", () => {
    const drift = TABLE.filter((r) => found.has(r.file) && found.get(r.file) !== r.count).map(
      (r) => `${r.file}: table ${r.count}, source ${found.get(r.file)}`,
    );
    expect(drift).toEqual([]);
  });

  it("(c) no table file has lost its mutator (remove the row)", () => {
    expect(TABLE.filter((r) => !found.has(r.file)).map((r) => r.file)).toEqual([]);
  });

  it("(d) each row lists one classified, reasoned mutator per counted mutator", () => {
    for (const r of TABLE) {
      expect(r.mutators).toHaveLength(r.count);
      for (const m of r.mutators) {
        expect(["till-guarded", "non-till", "known-gap"]).toContain(m.class);
        expect(m.reason.length).toBeGreaterThan(20);
      }
      if (r.mutators.some((m) => m.class === "till-guarded"))
        expect((r.guardMarkers ?? []).length + (r.guardedBy ?? []).length).toBeGreaterThan(0);
    }
  });

  it("(e) a till-guarded file (or its named callers) still calls its counter guard", () => {
    const missing: string[] = [];
    for (const r of TABLE) {
      if (!r.mutators.some((m) => m.class === "till-guarded")) continue;
      for (const marker of r.guardMarkers ?? [])
        if (!read(r.file).includes(marker)) missing.push(`${r.file}: ${marker}`);
      for (const g of r.guardedBy ?? [])
        if (!read(g.file).includes(g.marker)) missing.push(`${g.file}: ${g.marker}`);
    }
    expect(missing).toEqual([]);
  });

  it("(f) the guard itself still judges PER ROW with the one tender predicate and the closed-window read", () => {
    const guard = read("invoices/counter-payment-guard.ts");
    expect(guard).toContain("isCounterTenderRow(scope.orderId, r, scope, scope.saleRows)");
    expect(guard).toContain("counterWindowClosed(tx, scope.tenantId, scope.registerKey");
    expect(guard).toContain('order.fulfillPath === "PICKUP"');
    // The shared lock is taken for any scoped invoice (counter sale OR pickup order), never conditional on counterSale alone.
    expect(guard).toContain("lockCounterClose(tx, scope.tenantId, scope.registerKey)");
  });

  it("(g) the scanner counts what it should (a commented-out mutator is not one; a chained call is)", () => {
    expect(countMutators("await tx.invoicePayment.update({})\n// tx.invoicePayment.delete(")).toBe(
      1,
    );
    expect(countMutators("/*\n tx.invoicePayment.deleteMany()\n*/\nx")).toBe(0);
    expect(countMutators("await db\n  .invoicePayment\n  .updateMany({})")).toBe(1);
    expect(countMutators("await deleteMoneyRecordCas(tx.invoicePayment, { a: 1 })")).toBe(1);
    expect(countMutators("data: { payments: { deleteMany: {} } }")).toBe(1);
    expect(countMutators('await tx.$executeRaw`DELETE FROM "InvoicePayment" WHERE 1=1`')).toBe(1);
    expect(countMutators("await tx.invoicePayment.create({}); tx.invoicePayment.findFirst()")).toBe(
      0,
    );
  });
});
