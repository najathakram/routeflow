/**
 * SA-839 R16 (G4 pin): three structural pins on the regulated sales ledger, each with a detector
 * self-test that fails on an empty scan (so a broken regex can never report green).
 *
 *  1. Append-only: no `regulatedSalesLedger.delete|deleteMany|update|updateMany|upsert` (nor a raw
 *     DELETE / UPDATE of "RegulatedSalesLedger") anywhere in `apps/api/src`. An undo is a counter-entry.
 *  2. One helper: the three whole-invoice / undo primitives (`reverseInvoiceEntries`,
 *     `unreverseReturnEntries`, `unreverseCreditNoteEntries`) are private and are called only from
 *     `settleRegulatedLedger`'s own steps inside `regulated-ledger.service.ts`.
 *  3. Locks: every `settleRegulatedLedger` call site is classified below with the lock calls that must
 *     come before it in the same function (house order Return -> Order -> Invoice, SA-214 /
 *     orders/order-inline-return.ts). A caller-tx wrapper (it runs on its caller's locks) is listed
 *     with its own call sites, each of which must show the locks.
 *
 * Add a row (with the proof the lock really comes first) to classify a new caller; never loosen a scan.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly, collectSourceFiles } from "../testing/source-scan";

interface CallSite {
  file: string;
  fn: string;
  method: string;
  /** The enclosing function's text from its head up to the call. */
  scope: string;
  line: number;
}

/**
 * A function head: a class member or a top-level function whose line ENDS the signature (`{`, or an
 * open `(` for a multi-line parameter list). A bare call statement at the same indent (`  foo(a, b);`)
 * is not a head, which keeps a top-level function's body from being mis-attributed (the
 * `common/order-lock-callers.guard.spec.ts` HEAD shape).
 */
const HEAD =
  /^(?:(?:export )?(?:async )?function (\w+)\b[^\n]*|  (?:(?:private|public|protected|static|readonly) )*(?:async )?(\w+)\((?:[^\n]*\{[ \t]*|[ \t]*))$/gm;
const NOT_A_FUNCTION = new Set(["if", "for", "while", "switch", "catch", "return"]);

/** Every call of `re` (its last group is the method) with the function that encloses it. */
function findCalls(file: string, text: string, re: RegExp): CallSite[] {
  const code = codeOnly(text);
  const out: CallSite[] = [];
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(code))) {
    let fn = "<module>";
    let start = 0;
    HEAD.lastIndex = 0;
    let h: RegExpExecArray | null;
    while ((h = HEAD.exec(code)) && h.index < m.index) {
      const name = h[1] ?? h[2];
      if (NOT_A_FUNCTION.has(name)) continue;
      fn = name;
      start = h.index;
    }
    out.push({
      file,
      fn,
      method: m[m.length - 1],
      scope: code.slice(start, m.index),
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const rel = (f: string) => path.relative(API_SRC_ROOT, f).replace(/\\/g, "/");
/** Production source only: test harnesses under a `testing/` folder hold mocks, not writers. */
const PRODUCTION = collectSourceFiles().filter((f) => !/[\\/]testing[\\/]/.test(f));
const read = (f: string) => fs.readFileSync(f, "utf8");

// ── 1. append-only ──────────────────────────────────────────────────────────
const LEDGER_MUTATION =
  /regulatedSalesLedger\s*\.\s*(delete|deleteMany|update|updateMany|upsert)\s*\(|(?:DELETE\s+FROM|UPDATE)\s+"RegulatedSalesLedger"/g;

function ledgerMutations(file: string, text: string): string[] {
  const code = codeOnly(text);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(LEDGER_MUTATION.source, "g");
  while ((m = g.exec(code))) out.push(`${file}:${code.slice(0, m.index).split("\n").length}`);
  return out;
}

// ── 2. one helper ───────────────────────────────────────────────────────────
const PRIMITIVE_CALL =
  /\.(reverseInvoiceEntries|unreverseReturnEntries|unreverseCreditNoteEntries)\s*\(/;
const LEDGER_FILE = "regulated/regulated-ledger.service.ts";
/** The helper's own steps: the only functions that may call a primitive. */
const HELPER_STEPS = new Set([
  "settleRegulatedLedger",
  "settleInvoiceBilled",
  "settleAdjustmentUndone",
]);

function primitiveCalls(file: string, text: string): CallSite[] {
  return findCalls(file, text, PRIMITIVE_CALL);
}

// ── 3. locks ────────────────────────────────────────────────────────────────
const SETTLE_CALL = /\.(settleRegulatedLedger)\s*\(/;

/** A call site and the lock calls that must appear, in this order, before it in the same function. */
interface LockRow {
  locks: string[];
  why: string;
}

const SETTLE_SITES: Record<string, LockRow> = {
  "invoices/invoices.service.ts#voidInvoiceInTx": {
    locks: ["tx.invoice.updateMany("],
    why: "caller-tx: the VOID claim write-locks the Invoice; every caller holds the Order first (WRAPPER_CALLERS.voidInvoiceInTx)",
  },
  "invoices/invoices.service.ts#resyncInvoiceLedger": {
    locks: [],
    why: "caller-tx wrapper (INVOICE_BILLED): every caller holds the locks (WRAPPER_CALLERS.resyncInvoiceLedger)",
  },
  "invoices/invoices.service.ts#deleteInvoice": {
    locks: ['FROM "Order"', 'FROM "Invoice"'],
    why: "SA-608g: Order then Invoice FOR UPDATE, re-read under them",
  },
  "orders/orders.service.ts#deleteOrder": {
    locks: ["lockDeleteLines(", "lockRows: true"],
    why: "B284: the Order first; the post-release assertNoUnspentSourcedCredits takes the Invoice rows last",
  },
  "customers/customers.service.ts#deleteAllCustomers": {
    locks: ["releaseLiveOrderStockInTx(", "lockInvoiceRowsInOrder("],
    why: "B1241: the live Orders (then Products); SA-839: the purged Invoices, id order, before the settle",
  },
  "customers/customers.service.ts#runImportedCustomersCleanup": {
    locks: ["releaseLiveOrderStockInTx(", "lockInvoiceRowsInOrder("],
    why: "as deleteAllCustomers",
  },
  "returns/returns.service.ts#cancel": {
    locks: ['FROM "Return"', "lockLedgerDocumentRows("],
    why: "SA-839 F3: Return, then the Orders and Invoices of the return's ledger rows, id order",
  },
  "returns/inline-returns.service.ts#cancel": {
    locks: ['FROM "Return"', "lockLedgerDocumentRows("],
    why: "SA-839 F3: Return, then the carrying + source Orders and their Invoices, id order",
  },
  "credit-notes/credit-notes.service.ts#voidWithReversalInTx": {
    locks: ['FROM "Order"', 'FROM "Invoice"'],
    why: "SA-214 Order -> Invoice -> CreditNote, the note's ledger invoices joined into the sorted sets",
  },
  "credit-notes/credit-notes.service.ts#cancelStandaloneInTx": {
    locks: [],
    why: "caller-tx: InlineReturnsService.cancel holds Return -> Orders -> Invoices, this note's included (WRAPPER_CALLERS.cancelStandaloneInTx)",
  },
};

const WRAPPER_CALLERS: Record<string, Record<string, LockRow>> = {
  voidInvoiceInTx: {
    "invoices/invoices.service.ts#voidInvoice": {
      locks: ["lockInvoiceRow("],
      why: "SA-404: Order then Invoice, the tx's first statement",
    },
    "orders/order-cancel-tx.ts#cancelOrderInTx": {
      locks: ["lockOrderForCancel("],
      why: "Order then its Invoices (lockOrderForCancel), the tx's first statement",
    },
  },
  resyncInvoiceLedger: {
    "invoices/invoices.service.ts#rebuildSiblingDrafts": {
      locks: [],
      why: "caller-tx: every reconcile entry locks the Order (lockOrderRow / the delivered-basis stop locks) before the rebuild",
    },
    "invoices/invoices.service.ts#update": {
      locks: ["loadLockedInvoiceForEdit("],
      why: "the DRAFT edit: Order then Invoice (locked-invoice-edit.ts), re-read under them",
    },
    "invoices/invoices.service.ts#applyPriceAdjustment": {
      locks: ["lockInvoiceForPriceAdjustment("],
      why: "B662: the Invoice row first (its own documented order); the DRAFT branch re-syncs under it",
    },
    "invoices/invoices.service.ts#unvoidInvoice": {
      locks: ["lockInvoiceRow("],
      why: "SA-760 R-1: Order then Invoice, before the B693 check and the B299 re-claim",
    },
  },
  cancelStandaloneInTx: {
    "returns/inline-returns.service.ts#cancel": {
      locks: ['FROM "Return"', "lockLedgerDocumentRows("],
      why: "the inline cancel's lock set includes the note's ledger rows",
    },
  },
};

const siteKey = (s: CallSite) => `${s.file}#${s.fn}`;

/** The rows whose lock calls are missing, or out of order, before the call. */
function lockOffenders(sites: CallSite[], table: Record<string, LockRow>): string[] {
  const out: string[] = [];
  for (const s of sites) {
    const row = table[siteKey(s)];
    if (!row) {
      out.push(`${siteKey(s)}:${s.line} is not classified`);
      continue;
    }
    let from = 0;
    for (const lock of row.locks) {
      const at = s.scope.indexOf(lock, from);
      if (at < 0) {
        out.push(`${siteKey(s)}:${s.line} has no "${lock}" before the call (in order)`);
        break;
      }
      from = at + lock.length;
    }
  }
  return out;
}

function scan(re: RegExp): CallSite[] {
  return PRODUCTION.flatMap((f) => findCalls(rel(f), read(f), re));
}

describe("SA-839 R16: the regulated ledger is append-only, behind one helper, under locks", () => {
  it("the scan covers the source tree (an empty or mis-rooted scan fails here)", () => {
    expect(PRODUCTION.length).toBeGreaterThan(200);
    expect(PRODUCTION.map(rel)).toContain(LEDGER_FILE);
  });

  describe("1. append-only", () => {
    it("detector self-test: a planted ledger delete, update and raw DELETE are each found", () => {
      expect(
        ledgerMutations("x.ts", "await db.regulatedSalesLedger.deleteMany({ where });"),
      ).toHaveLength(1);
      expect(
        ledgerMutations("x.ts", "await tx.regulatedSalesLedger.update({ where, data });"),
      ).toHaveLength(1);
      expect(
        ledgerMutations(
          "x.ts",
          'await tx.$executeRaw`DELETE FROM "RegulatedSalesLedger" WHERE 1`;',
        ),
      ).toHaveLength(1);
      expect(
        ledgerMutations("x.ts", "// regulatedSalesLedger.deleteMany( in a comment"),
      ).toHaveLength(0);
      expect(
        ledgerMutations("x.ts", "await db.regulatedSalesLedger.createMany({ data });"),
      ).toHaveLength(0);
    });

    it("no ledger row is ever deleted or updated in apps/api/src", () => {
      expect(PRODUCTION.flatMap((f) => ledgerMutations(rel(f), read(f)))).toEqual([]);
    });
  });

  describe("2. one helper", () => {
    it("detector self-test: a planted direct primitive call is found", () => {
      const planted = primitiveCalls(
        "x.ts",
        "  async voidIt(tx: any) {\n    await this.ledger.reverseInvoiceEntries({ invoiceId, db: tx });\n  }\n",
      );
      expect(planted.map(siteKey)).toEqual(["x.ts#voidIt"]);
    });

    it("the three primitives are private", () => {
      const code = codeOnly(read(path.join(API_SRC_ROOT, LEDGER_FILE)));
      const declared = [
        "reverseInvoiceEntries",
        "unreverseReturnEntries",
        "unreverseCreditNoteEntries",
      ].map((name) => [name, new RegExp(`\\n  private async ${name}\\(`).test(code)]);
      expect(declared).toEqual([
        ["reverseInvoiceEntries", true],
        ["unreverseReturnEntries", true],
        ["unreverseCreditNoteEntries", true],
      ]);
    });

    it("no primitive is called outside the helper's own steps", () => {
      const calls = scan(PRIMITIVE_CALL);
      const offenders = calls
        .filter((c) => c.file !== LEDGER_FILE || !HELPER_STEPS.has(c.fn))
        .map((c) => `${siteKey(c)}:${c.line} calls ${c.method}`);
      expect(offenders).toEqual([]);
      // the helper really calls all three (guards the scan turning vacuous)
      expect(new Set(calls.filter((c) => c.file === LEDGER_FILE).map((c) => c.method))).toEqual(
        new Set(["reverseInvoiceEntries", "unreverseReturnEntries", "unreverseCreditNoteEntries"]),
      );
    });
  });

  describe("3. locks", () => {
    it("detector self-test: an unclassified caller and an unlocked classified caller are each flagged", () => {
      const planted = findCalls(
        "x/y.ts",
        "  async undo(tx: any) {\n    await this.ledger.settleRegulatedLedger(tx, { kind: 'INVOICE_ZEROED', invoiceId });\n  }\n",
        SETTLE_CALL,
      );
      expect(lockOffenders(planted, {})).toEqual(["x/y.ts#undo:2 is not classified"]);
      expect(
        lockOffenders(planted, { "x/y.ts#undo": { locks: ['FROM "Order"'], why: "" } }),
      ).toEqual(['x/y.ts#undo:2 has no "FROM "Order"" before the call (in order)']);
    });

    it("every settleRegulatedLedger call site is classified, none is stale, and each holds its locks first", () => {
      const sites = scan(SETTLE_CALL);
      expect(sites.length).toBeGreaterThanOrEqual(Object.keys(SETTLE_SITES).length);
      expect([...new Set(sites.map(siteKey))].sort()).toEqual(Object.keys(SETTLE_SITES).sort());
      expect(lockOffenders(sites, SETTLE_SITES)).toEqual([]);
    });

    it("every call of a caller-tx wrapper is classified and holds its locks first", () => {
      for (const [wrapper, table] of Object.entries(WRAPPER_CALLERS)) {
        const sites = scan(new RegExp(`\\.(${wrapper})\\s*\\(`));
        expect([wrapper, [...new Set(sites.map(siteKey))].sort()]).toEqual([
          wrapper,
          Object.keys(table).sort(),
        ]);
        expect(lockOffenders(sites, table)).toEqual([]);
      }
    });
  });
});
