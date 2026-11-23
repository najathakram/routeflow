/**
 * SA-1208 D7 sites pin: "what credit is available" is computed in available-credit.ts and nowhere else.
 *
 * Part 1: the three statement files carry no credit arithmetic of their own (no `amountUsed` read, no advance
 * `balance` sum) and import the helper. Part 2: a census of every non-spec file under `apps/api/src` that reads a
 * credit note's `.amountUsed`. A NEW file that does is a new place that may answer the same question: add it to
 * CENSUS with the question it answers, or route it through available-credit.ts.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

const STATEMENT_FILES = [
  "customers/customer-statement.ts",
  "customers/account-statement.ts",
  "buyer/statement.service.ts",
];

/** A credit note's `amountUsed` or an advance's `balance`, read by dot OR bracket (`n["amountUsed"]`). */
const AMOUNT_USED = /(\.|\[\s*["'`])amountUsed/g;
const BALANCE = /(\.|\[\s*["'`])balance\b/g;
/** Any read of the credit tables: a statement file may not run its own credit query. */
const CREDIT_READS =
  /\b(creditNote|advancePayment)\s*\.\s*(findMany|findFirst|aggregate|groupBy|count)/g;
const count = (code: string, re: RegExp) => (code.match(re) ?? []).length;

/**
 * What each statement file may still read directly, each a LEDGER DISPLAY or a different question, never the wallet:
 * customer-statement: the ledger's capped note and advance reads, the operator note read, one `n.amountUsed` (the
 * operator-only sweep amount) and two ledger-row `balance` displays; account-statement: the notes and advances reads
 * behind its credit LIST (its total goes through the helper).
 */
const ALLOWED: Record<string, { amountUsed: number; balance: number; reads: number }> = {
  "customers/customer-statement.ts": { amountUsed: 1, balance: 2, reads: 3 },
  "customers/account-statement.ts": { amountUsed: 0, balance: 0, reads: 2 },
  "buyer/statement.service.ts": { amountUsed: 0, balance: 0, reads: 0 },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Files that read `.amountUsed`, each with the different question it answers. Not "available credit". */
const CENSUS: Record<string, string> = {
  "bookkeeping/bookkeeping.service.ts": "ledger export of one credit note's remainder",
  "credit-notes/auto-apply-candidates.ts":
    "which notes the send-time sweep may spend (sweepable, not display)",
  "credit-notes/credit-note-summary.ts": "the credit-notes screen's open-credit tile",
  "credit-notes/credit-notes.service.ts":
    "writers and guards of a note's own spend, void and restore",
  "credit-notes/sourced-credit-guard.ts": "the inline-return delete guard on one sourced note",
  "customers/customer-statement.ts":
    "operator-only autoApplyCredit (the sweep amount), not the wallet",
  "customers/customers.service.ts": "does the customer own any open note (delete guard)",
  "invoices/invoices.service.ts": "credit-note payment edit headroom",
};

describe("SA-1208 D7 sites pin: available credit has one home", () => {
  it.each(STATEMENT_FILES)("%s computes no credit of its own", (rel) => {
    const code = stripComments(read(rel));
    // SA-1214 / read A: dot AND bracket access, an advance `balance` read, and any new credit-table read.
    expect({
      amountUsed: count(code, AMOUNT_USED),
      balance: count(code, BALANCE),
      reads: count(code, CREDIT_READS),
    }).toEqual(ALLOWED[rel]);
    expect(code).not.toMatch(/\.reduce\([^;]*\.balance\b/); // no advance balance sum (a ledger row's display is fine)
    expect(code).toMatch(/available-credit/); // and it imports the helper
  });

  it("no new file reads a credit note's amountUsed without being classified", () => {
    const found = walk(SRC)
      .filter((f) => count(stripComments(fs.readFileSync(f, "utf8")), AMOUNT_USED) > 0)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((f) => f !== "customers/available-credit.ts")
      .sort();
    expect(found).toEqual(Object.keys(CENSUS).sort());
  });
});

/** Non-spec files that sum or aggregate `advancePayment` balances, each with the different question it answers. */
const ADVANCE_BALANCE_CENSUS: Record<string, string> = {
  "customers/customers.service.ts":
    "the delete/merge liability test: any advance balance, any status, by design (SA-1214 A1 A-F4)",
  "invoices/payment-list-query.ts": "the staff payments screen's own advance summary",
};

describe("SA-1214 A1 sites pin: advance balances are summed in available-credit.ts only", () => {
  it("no file outside the census sums advance balances", () => {
    const readers = walk(SRC)
      .filter((f) => {
        const code = stripComments(fs.readFileSync(f, "utf8"));
        const touches = /advancePayment\s*\.\s*(findMany|aggregate|groupBy)/.test(code);
        // a `_sum` of balance, a reduce over `.balance`, or a for-loop that adds `.balance`
        const sums =
          /_sum\s*:\s*\{[^}]*balance|\.reduce\(\s*\([^)]*\)\s*=>[^;,]*\.balance|\bfor\s*\([^)]*\)\s*\{[^}]*(\+=|=\s*\w+\s*\+)[^;]*\.balance/.test(
            code,
          );
        return touches && sums;
      })
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((f) => f !== "customers/available-credit.ts")
      .sort();
    expect(readers).toEqual(Object.keys(ADVANCE_BALANCE_CENSUS).sort());
  });
});
