/**
 * G4 — source-scan pin: EVERY writer of an `InvoicePayment` row under `apps/api/src` is classified.
 *
 * A CASH payment on a counter invoice is TILL money (`isTillCashRow`, orders/counter-sale/counter-till-cash.ts): the end-of-day
 * close counts it, so a writer that stores one without the shared close lock + the database clock + the dated check
 * (`counterPay.lock` / `counterPay.assertDatedOk`, invoices/counter-payment-guard.ts) can commit cash that lands in NO window.
 * A bookkeeping door was found doing exactly that. This spec makes the next new writer fail the build until somebody reads it and
 * decides which class it is in:
 *
 *  - "till-guarded"      takes the counter close lock and runs the dated check (the one door every till payment goes through).
 *  - "non-till"          cannot create a till-cash row: the method is never CASH (credit-note / advance applications), or the
 *                        row always carries a payment group (a till tender is ungrouped by definition).
 *  - "historical-import" an import of PAST data: it back-dates `createdAt` to the source system's date and never touches a
 *                        counter order, so it is not a till event.
 *  - "known-gap"         a REAL till-cash hole that is ruled out of scope and recorded here so it stays visible.
 *
 * It fails when (a) a file holds a writer but is not in the table, (b) a file's writer count differs from the table, (c) a table
 * file no longer holds a writer, (d) a "till-guarded" file stops calling its guard.
 *
 * Counted: `invoicePayment.create | createMany | upsert` on any client/tx, and a raw `INSERT INTO "InvoicePayment"`. Comment
 * lines are ignored; `*.spec.ts`, `*.test.ts` and `testing/` helpers are excluded (they are fixtures, not writers).
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

type WriterClass = "till-guarded" | "non-till" | "historical-import" | "known-gap";

interface Writer {
  /** Informational: where in the file this writer lives (the nth writer in source order). */
  where: string;
  class: WriterClass;
  reason: string;
}

interface Row {
  file: string;
  count: number;
  writers: Writer[];
  /** Required in the file when ANY of its writers is "till-guarded". */
  guardMarker?: string;
}

const TABLE: Row[] = [
  {
    file: "bookkeeping/bookkeeping.service.ts",
    count: 1,
    guardMarker: "counterPay.assertDatedOk",
    writers: [
      {
        where: "recordPayment (POST /bookkeeping/transactions/:id/payments)",
        class: "till-guarded",
        reason:
          "G4: counter scope read before the tx, shared close lock first, DB-clock paidAt and the dated check, like the office door",
      },
    ],
  },
  {
    file: "invoices/invoices.service.ts",
    count: 3,
    guardMarker: "counterPay.assertDatedOk",
    writers: [
      {
        where: "recordPayment (office door; also the counter tender/pickup with tillLockHeld)",
        class: "till-guarded",
        reason: "shared close lock, DB-clock paidAt and counterPay.assertDatedOk (SA-750r3)",
      },
      {
        where: "recordDeliveryPaymentInTx (driver cash at stop completion)",
        class: "known-gap",
        reason:
          "method may be CASH, paidAt is the app clock and no close lock is taken; SA ruled it out of scope for v1 (driver cash is not till cash), but a counter order is not structurally barred from a route stop",
      },
      {
        where: "recordStandalonePayment (multi-invoice allocation)",
        class: "non-till",
        reason:
          "every row carries a fresh paymentGroupId, and a till tender is ungrouped (isCounterTenderGroup)",
      },
    ],
  },
  {
    file: "customers/customers.service.ts",
    count: 1,
    writers: [
      {
        where: "applyAdvancePaymentToInvoiceLocked",
        class: "non-till",
        reason:
          "method is always ADVANCE, never CASH (the cash was banked when the advance was taken)",
      },
    ],
  },
  {
    file: "credit-notes/credit-notes.service.ts",
    count: 1,
    writers: [
      {
        where: "applyCreditInTx",
        class: "non-till",
        reason: "method is always CREDIT_NOTE, never CASH",
      },
    ],
  },
  {
    file: "import/import.service.ts",
    count: 3,
    writers: [
      {
        where: "invoice import, prior invoice branch (synthetic zoho-import payment)",
        class: "historical-import",
        reason: "method OTHER, createdAt back-dated to the source system; never a till event",
      },
      {
        where: "invoice import, new invoice branch (synthetic zoho-import payment)",
        class: "historical-import",
        reason: "method OTHER, createdAt back-dated to the source system; never a till event",
      },
      {
        where: "payment import (real payments from the source system)",
        class: "historical-import",
        reason:
          "past payments of an imported ledger, createdAt back-dated; imported invoices have no counter-sale order, so no close window contains them",
      },
    ],
  },
];

const WRITER_RE =
  /\binvoicePayment\s*\.\s*(create|createMany|upsert)\b|INSERT\s+INTO\s+"InvoicePayment"/g;

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

function countWriters(text: string): number {
  let n = 0;
  let inBlock = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("//")) continue;
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("*")) continue;
    n += (line.match(WRITER_RE) ?? []).length;
  }
  return n;
}

const found = new Map<string, number>();
for (const file of sourceFiles(SRC_ROOT)) {
  const n = countWriters(fs.readFileSync(file, "utf8"));
  if (n > 0) found.set(path.relative(SRC_ROOT, file).split(path.sep).join("/"), n);
}

describe("InvoicePayment writers are all classified (G4)", () => {
  it("(a) no writer lives in a file the table does not know: classify it before it ships", () => {
    const known = new Set(TABLE.map((r) => r.file));
    const unclassified = [...found.keys()].filter((f) => !known.has(f));
    expect(unclassified).toEqual([]);
  });

  it("(b) every table file holds exactly the pinned number of writers", () => {
    const drift = TABLE.filter((r) => found.has(r.file) && found.get(r.file) !== r.count).map(
      (r) => `${r.file}: table ${r.count}, source ${found.get(r.file)}`,
    );
    expect(drift).toEqual([]);
  });

  it("(c) no table file has lost its writer (remove the row)", () => {
    expect(TABLE.filter((r) => !found.has(r.file)).map((r) => r.file)).toEqual([]);
  });

  it("(d) each row lists one classified, reasoned writer per counted writer", () => {
    for (const r of TABLE) {
      expect(r.writers).toHaveLength(r.count);
      for (const w of r.writers) {
        expect(["till-guarded", "non-till", "historical-import", "known-gap"]).toContain(w.class);
        expect(w.reason.length).toBeGreaterThan(20);
      }
    }
  });

  it("(e) a till-guarded file still calls its counter guard", () => {
    const missing = TABLE.filter((r) => r.writers.some((w) => w.class === "till-guarded")).filter(
      (r) => !fs.readFileSync(path.join(SRC_ROOT, r.file), "utf8").includes(r.guardMarker ?? "\0"),
    );
    expect(missing.map((r) => r.file)).toEqual([]);
  });

  it("(f) the scanner counts what it should (a commented-out writer is not one)", () => {
    expect(countWriters("await tx.invoicePayment.create({})\n// tx.invoicePayment.create(")).toBe(
      1,
    );
    expect(countWriters("/*\n tx.invoicePayment.createMany()\n*/\nx")).toBe(0);
    expect(countWriters('await tx.$executeRaw`INSERT INTO "InvoicePayment" (id) VALUES (1)`')).toBe(
      1,
    );
  });
});
