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
    const reads = code.match(/\.amountUsed/g) ?? [];
    // customer-statement.ts keeps ONE read: the operator-only sweep amount (`n.amountUsed`), a different question.
    const allowed = rel === "customers/customer-statement.ts" ? 1 : 0;
    expect(reads.length).toBe(allowed);
    expect(code).not.toMatch(/\.reduce\([^;]*\.balance\b/); // no advance balance sum (a ledger row's display is fine)
    expect(code).toMatch(/available-credit/); // and it imports the helper
  });

  it("no new file reads a credit note's amountUsed without being classified", () => {
    const found = walk(SRC)
      .filter((f) => /\.amountUsed/.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((f) => f !== "customers/available-credit.ts")
      .sort();
    expect(found).toEqual(Object.keys(CENSUS).sort());
  });
});
