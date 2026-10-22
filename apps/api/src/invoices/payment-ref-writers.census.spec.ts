import * as fs from "fs";
import * as path from "path";

/**
 * Row 498 / lead ruling 3 and 4: EVERY InvoicePayment writer is on this list, and each is either behind the ONE
 * reference predicate (payment-ref-dedupe.ts) or carries a written reason it has no customer-typed reference.
 * A new `invoicePayment.create` / `createMany` / `upsert` (or a nested `payments: { create`) anywhere in
 * apps/api/src that is not listed here FAILS the build: add it to the list, route it through the predicate, or
 * state why it cannot carry a reference. Also pins the lock order: the payment-ref lock is the INNERMOST of the
 * customer-keyed locks (the customer merge lock, when a path holds it, is taken first).
 */
const SRC = path.resolve(__dirname, "..");

type Kind = "GUARDED" | "NO_REFERENCE" | "SYSTEM_METHOD" | "IMPORT";
const WRITERS: Record<string, { creates: number; kind: Kind; why: string }> = {
  "invoices/invoices.service.ts": {
    creates: 3,
    kind: "GUARDED",
    why: "writeInvoicePayment + writeStandalonePayment run behind keyedPayment (payment-idempotency.ts), which composes the predicate; the third create is recordDeliveryPaymentInTx (a driver's at-door cash: it carries no reference).",
  },
  "bookkeeping/bookkeeping.service.ts": {
    creates: 1,
    kind: "GUARDED",
    why: "BookkeepingService.recordPayment (POST /bookkeeping/transactions/:id/payments) calls the same predicate and lock.",
  },
  "credit-notes/credit-notes.service.ts": {
    creates: 1,
    kind: "SYSTEM_METHOD",
    why: "method CREDIT_NOTE, server-generated reference: not a customer-typed payment reference.",
  },
  "customers/customers.service.ts": {
    creates: 1,
    kind: "SYSTEM_METHOD",
    why: "method ADVANCE (applies an advance balance), server-generated AP-<id> reference.",
  },
  "import/import.service.ts": {
    creates: 3,
    kind: "IMPORT",
    why: "bulk import, already idempotent on the source system's own payment id (zohoId / reference per invoice).",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.includes(".fake-"))
      out.push(p);
  }
  return out;
}
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const WRITE_RE =
  /invoicePayment\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\b|payments:\s*\{\s*create/g;

describe("row 498: the InvoicePayment writer census", () => {
  const found = new Map<string, number>();
  for (const f of walk(SRC)) {
    const n = (fs.readFileSync(f, "utf8").match(WRITE_RE) ?? []).length;
    if (n) found.set(path.relative(SRC, f), n);
  }

  it("lists every InvoicePayment writer in apps/api/src, with its count (a new writer fails here)", () => {
    const actual = Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
    const expected = Object.fromEntries(
      Object.entries(WRITERS)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v.creates]),
    );
    expect(actual).toEqual(expected);
  });

  it("every GUARDED writer file reaches the ONE predicate module", () => {
    expect(read("invoices/payment-idempotency.ts")).toContain('from "./payment-ref-dedupe"');
    expect(read("invoices/payment-idempotency.ts")).toContain("createPaymentRefGuard");
    expect(read("invoices/invoices.service.ts")).toMatch(
      /keyedPayment\(this\.prisma, invoicePaymentKey/,
    );
    expect(read("invoices/invoices.service.ts")).toMatch(
      /keyedPayment\(this\.prisma, standalonePaymentKey/,
    );
    const book = read("bookkeeping/bookkeeping.service.ts");
    expect(book).toContain("payment-ref-dedupe");
    expect(book).toContain("createPaymentRefGuard");
    expect(book).toContain("withPaymentRefLock");
  });

  it("the predicate and the lock are defined in exactly one file", () => {
    const definers = [...walk(SRC)]
      .filter((f) =>
        /export (?:async )?function (?:createPaymentRefGuard|withPaymentRefLock)\b/.test(
          fs.readFileSync(f, "utf8"),
        ),
      )
      .map((f) => path.relative(SRC, f));
    expect(definers).toEqual(["invoices/payment-ref-dedupe.ts"]);
  });

  it("LOCK ORDER: only payment-ref-dedupe.ts opens the payment-ref family; no file that takes it also takes the customer merge lock", () => {
    const takers = walk(SRC).filter((f) =>
      /family:\s*"payment-ref"/.test(fs.readFileSync(f, "utf8")),
    );
    expect(takers.map((f) => path.relative(SRC, f))).toEqual(["invoices/payment-ref-dedupe.ts"]);
    // the definition itself is not a call site
    const callers = walk(SRC).filter(
      (f) =>
        !f.endsWith("invoices/payment-ref-dedupe.ts") &&
        /withPaymentRefLock\(/.test(fs.readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => path.relative(SRC, f)).sort()).toEqual([
      "bookkeeping/bookkeeping.service.ts",
      "invoices/payment-idempotency.ts",
    ]);
    // M2: the files whose inTx / claim hooks run UNDER the lock are scanned too (they must never take the merge lock).
    const hookFiles = [
      "invoices/invoices.service.ts",
      "payment-requests/payment-requests.service.ts",
    ].map((rel) => path.join(SRC, rel));
    for (const f of [...takers, ...callers, ...hookFiles]) {
      const text = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect({ file: path.relative(SRC, f), takesMergeLock: /"order-merge"/.test(text) }).toEqual({
        file: path.relative(SRC, f),
        takesMergeLock: false,
      });
    }
  });
});

/**
 * SA-837b item 2 / gate G4: the AdvancePayment writers get the same census. A new `advancePayment.create`
 * anywhere in apps/api/src that is not listed here FAILS the build.
 */
const ADVANCE_WRITERS: Record<string, { creates: number; why: string }> = {
  "customers/customers.service.ts": {
    creates: 1,
    why: "GUARDED: createAdvancePayment (POST /customers/:id/advance-payments) runs behind keyedPayment with and without a key (the ADVANCE_PAYMENT scope is no longer skipped), so it repeats neither an advance nor an invoice payment.",
  },
  "invoices/invoices.service.ts": {
    creates: 2,
    why: "GUARDED VIA PARENT: the standalone payment's excess advance (writeStandalonePayment, behind keyedPayment: its group check counts the advance) and recordDeliveryPaymentInTx's at-door over-collection (a driver's cash: no customer-typed reference, a server RUN:/STOP: reference).",
  },
};
const ADVANCE_RE = /advancePayment\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\b/g;

describe("SA-837b: the AdvancePayment writer census", () => {
  it("lists every AdvancePayment writer in apps/api/src, with its count (a new writer fails here)", () => {
    const actual: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const n = (fs.readFileSync(f, "utf8").match(ADVANCE_RE) ?? []).length;
      if (n) actual[path.relative(SRC, f)] = n;
    }
    const expected = Object.fromEntries(
      Object.entries(ADVANCE_WRITERS).map(([k, v]) => [k, v.creates]),
    );
    expect(Object.fromEntries(Object.entries(actual).sort())).toEqual(
      Object.fromEntries(Object.entries(expected).sort()),
    );
  });

  it("the advance writer reaches the guard: keyedPayment no longer skips ADVANCE_PAYMENT", () => {
    expect(read("invoices/payment-idempotency.ts")).not.toMatch(
      /scope === "ADVANCE_PAYMENT"\) return write/,
    );
    expect(read("customers/customers.service.ts")).toMatch(
      /keyedPayment\(this\.prisma, advancePaymentKey/,
    );
  });
});
