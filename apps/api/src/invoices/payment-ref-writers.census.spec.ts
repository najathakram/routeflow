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

/** A path relative to SRC with "/" separators, so the census keys match on Windows as well as on Linux CI. */
function toPosixRel(rel: string, sep: string = path.sep): string {
  return rel.split(sep).join("/");
}
const rel = (f: string) => toPosixRel(path.relative(SRC, f));

describe("census paths are separator-neutral", () => {
  it("a Windows-style relative path reads as the posix key", () => {
    expect(toPosixRel("bookkeeping\\bookkeeping.service.ts", "\\")).toBe(
      "bookkeeping/bookkeeping.service.ts",
    );
  });
  it("a posix relative path is unchanged", () => {
    expect(toPosixRel("invoices/payment-ref-dedupe.ts", "/")).toBe(
      "invoices/payment-ref-dedupe.ts",
    );
  });
});

type Kind = "GUARDED" | "NO_REFERENCE" | "SYSTEM_METHOD" | "IMPORT";
/**
 * Row 2299 / SA-858 ruling 4: the SECOND axis of the same table, one capacity kind per create site (in file order).
 * CAPACITY: checked with capacityRefusal / remainingCapacity (@routeflow/pricing) on the non-VOID basis. CAPTURED: money
 * already taken outside RouteFlow, never refused (SA-837b). SPILL: caps on the CONFIRMED balance and books the excess as
 * an advance. IMPORT: reproduces the source system's ledger, no check by design. CONFIRMED: sizes on the CONFIRMED
 * balance by a standing decision; whether it moves to CAPACITY is the SA-864 owner question (real money vs an
 * unconfirmed row), so it is held, not missed.
 */
type CapacityKind = "CAPACITY" | "CAPTURED" | "SPILL" | "IMPORT" | "CONFIRMED";
const WRITERS: Record<
  string,
  { creates: number; kind: Kind; why: string; capacity: Array<{ kind: CapacityKind; why: string }> }
> = {
  "invoices/invoices.service.ts": {
    creates: 3,
    kind: "GUARDED",
    why: "writeInvoicePayment + writeStandalonePayment run behind keyedPayment (payment-idempotency.ts), which composes the predicate; the third create is recordDeliveryPaymentInTx (a driver's at-door cash: it carries no reference).",
    capacity: [
      {
        kind: "CAPACITY",
        why: "recordPayment: capacityRefusal on every capacity-consuming status (2299).",
      },
      {
        kind: "CONFIRMED",
        why: "writeStandalonePayment: the office path keeps [L-O2] (no capacity refusal; Σ allocations <= payment) and the captured path (capturedExternally) is CAPTURED, confirmed-basis and never refused (SA-858 amended). held: SA-864, owner question 7b.",
      },
      {
        kind: "SPILL",
        why: "recordDeliveryPaymentInTx caps on the CONFIRMED balance; excess to the advance (follow-up row).",
      },
    ],
  },
  "bookkeeping/bookkeeping.service.ts": {
    creates: 1,
    kind: "GUARDED",
    why: "BookkeepingService.recordPayment (POST /bookkeeping/transactions/:id/payments) calls the same predicate and lock.",
    capacity: [
      {
        kind: "CONFIRMED",
        why: "writeLedgerPayment sizes on CONFIRMED money (REG-B11, T-B11s); held: SA-864, owner question 7b.",
      },
    ],
  },
  "credit-notes/credit-notes.service.ts": {
    creates: 1,
    kind: "SYSTEM_METHOD",
    why: "method CREDIT_NOTE, server-generated reference: not a customer-typed payment reference.",
    capacity: [{ kind: "CAPACITY", why: "applyCreditInTx: remainingCapacity." }],
  },
  "customers/customers.service.ts": {
    creates: 1,
    kind: "SYSTEM_METHOD",
    why: "method ADVANCE (applies an advance balance), server-generated AP-<id> reference.",
    capacity: [{ kind: "CAPACITY", why: "applyAdvancePaymentToInvoiceLocked: remainingCapacity." }],
  },
  "import/import.service.ts": {
    creates: 3,
    kind: "IMPORT",
    why: "bulk import, already idempotent on the source system's own payment id (zohoId / reference per invoice).",
    capacity: [
      { kind: "IMPORT", why: "historical payment: paid = total - imported balanceDue." },
      { kind: "IMPORT", why: "historical payment rows of an imported invoice." },
      { kind: "IMPORT", why: "replaces an import placeholder row." },
    ],
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
    if (n) found.set(rel(f), n);
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

  it("row 2299 (R7): every create site carries a capacity kind (a new site fails until classified on both axes)", () => {
    for (const [file, w] of Object.entries(WRITERS))
      expect({ file, kinds: w.capacity.length }).toEqual({ file, kinds: w.creates });
  });

  it("row 2299 (SA-867 condition 2): the capacityRefusal callers are count-pinned (a new caller fails until classified)", () => {
    const callers: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const n = (fs.readFileSync(file, "utf8").match(/capacityRefusal\(/g) ?? []).length;
      if (n) callers[rel(file)] = n;
    }
    // recordPayment only today; the SA-864 owner answer lowers or raises this in the same diff
    expect(callers).toEqual({ "invoices/invoices.service.ts": 1 });
  });

  it("row 2299: every CONFIRMED site names its hold (SA-867 condition 1)", () => {
    for (const w of Object.values(WRITERS))
      for (const c of w.capacity)
        if (c.kind === "CONFIRMED") expect(c.why).toContain("held: SA-864, owner question 7b");
  });

  it("row 2299: recordPayment reaches the ONE capacity helper with an explicit policy; the CONFIRMED sites do not (SA-864)", () => {
    const inv = read("invoices/invoices.service.ts");
    expect(inv.match(/capacityRefusal\(/g)?.length).toBe(1); // recordPayment only, until the owner answers
    expect(inv).toMatch(/capacityRefusal\(\{[^}]*overpay: "REFUSE"/);
    expect(read("bookkeeping/bookkeeping.service.ts")).not.toMatch(/capacityRefusal\(/);
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
      .map((f) => rel(f));
    expect(definers).toEqual(["invoices/payment-ref-dedupe.ts"]);
  });

  it("LOCK ORDER: only payment-ref-dedupe.ts opens the payment-ref family; no file that takes it also takes the customer merge lock", () => {
    const takers = walk(SRC).filter((f) =>
      /family:\s*"payment-ref"/.test(fs.readFileSync(f, "utf8")),
    );
    expect(takers.map((f) => rel(f))).toEqual(["invoices/payment-ref-dedupe.ts"]);
    // the definition itself is not a call site
    const callers = walk(SRC).filter(
      (f) =>
        rel(f) !== "invoices/payment-ref-dedupe.ts" &&
        /withPaymentRefLock\(/.test(fs.readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => rel(f)).sort()).toEqual([
      "bookkeeping/bookkeeping.service.ts",
      "invoices/payment-edit-ref.ts",
      "invoices/payment-idempotency.ts",
    ]);
    // M2: the files whose inTx / claim hooks run UNDER the lock are scanned too (they must never take the merge lock).
    const hookFiles = [
      "invoices/invoices.service.ts",
      "payment-requests/payment-requests.service.ts",
    ].map((rel) => path.join(SRC, rel));
    for (const f of [...takers, ...callers, ...hookFiles]) {
      const text = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect({ file: rel(f), takesMergeLock: /"order-merge"/.test(text) }).toEqual({
        file: rel(f),
        takesMergeLock: false,
      });
    }
  });
});

/**
 * Row 752 / SA-843 ruling 7 (OP-7): every EDIT of an InvoicePayment row is listed with a kind per site. Only
 * updatePayment can change the method, reference or amount of a typed-reference row or move a row INTO the dedupe
 * set, and it runs the ONE predicate (GUARDED). A new `invoicePayment.update` / `updateMany` anywhere in
 * apps/api/src that is not listed here FAILS the build: add it with its kind, or route it through the guard.
 */
type EditKind = "GUARDED" | "SYSTEM_METHOD" | "TO_VOID" | "NO_KEY_FIELD";
const EDITS: Record<string, Array<{ kind: EditKind; why: string }>> = {
  "invoices/invoices.service.ts": [
    {
      kind: "GUARDED",
      why: "updatePayment: withPaymentEditRef (payment-edit-ref.ts) runs createPaymentRefGuard + withPaymentRefLock when the edit gives the row a new dedupe identity.",
    },
    { kind: "NO_KEY_FIELD", why: "setCheckStatus: check lifecycle dates and status only." },
    { kind: "TO_VOID", why: "a bounced check's payment moves OUT of the set (to VOID)." },
  ],
  "credit-notes/credit-notes.service.ts": [
    { kind: "SYSTEM_METHOD", why: "shrinks a CREDIT_NOTE row (system method, system reference)." },
    { kind: "SYSTEM_METHOD", why: "shrinks a CREDIT_NOTE row (system method, system reference)." },
  ],
  "invoices/payment-void-tx.ts": [
    { kind: "TO_VOID", why: "voidPayment: moves the row OUT of the set." },
  ],
  "invoices/payment-image.ts": [
    { kind: "NO_KEY_FIELD", why: "attach a receipt image to the group (image fields only)." },
    { kind: "NO_KEY_FIELD", why: "attach a receipt image to one row (image fields only)." },
    { kind: "NO_KEY_FIELD", why: "clear the group's receipt image (image fields only)." },
    { kind: "NO_KEY_FIELD", why: "clear one row's receipt image (image fields only)." },
  ],
};
const EDIT_RE = /invoicePayment\s*\.\s*update(?:Many)?\(/g;

describe("row 752: the InvoicePayment EDIT census (SA-843)", () => {
  it("lists every InvoicePayment edit in apps/api/src, with a kind per site (a new edit writer fails here)", () => {
    const actual: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const n = (fs.readFileSync(f, "utf8").match(EDIT_RE) ?? []).length;
      if (n) actual[rel(f)] = n;
    }
    const expected = Object.fromEntries(Object.entries(EDITS).map(([k, v]) => [k, v.length]));
    expect(Object.fromEntries(Object.entries(actual).sort())).toEqual(
      Object.fromEntries(Object.entries(expected).sort()),
    );
  });

  it("the GUARDED edit reaches the ONE predicate and its lock", () => {
    const edit = read("invoices/payment-edit-ref.ts");
    expect(edit).toContain('from "./payment-ref-dedupe"');
    expect(edit).toContain("createPaymentRefGuard");
    expect(edit).toContain("withPaymentRefLock");
    expect(read("invoices/invoices.service.ts")).toMatch(/withPaymentEditRef\(/);
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
      if (n) actual[rel(f)] = n;
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
