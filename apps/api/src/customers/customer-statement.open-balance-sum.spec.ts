/**
 * SA-1164 22:05Z (PR-2b), rows D2a and D3 count pin.
 *
 * D2a: `statementOutstandingAmount` is a status-free sum (the caller passes the open-balance set); over issued-only rows it
 * equals `summarizeOpenInvoices(rows, cutoff).unpaidTotal`, so the shared buyer receivables figure cannot drift from it.
 * D3: every reader under the S9 "same cents everywhere" pin keeps joining the receivable-DRAFT clause.
 */
import * as fs from "fs";
import * as path from "path";
import { overdueCutoff } from "../common/calendar-date";
import { summarizeOpenInvoices } from "../invoices/invoice-balance-classify";
import { statementOutstandingAmount } from "./customer-statement";

const NOW = new Date("2026-11-18T18:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const row = (
  status: string,
  total: number,
  paid: number[] = [],
  dueDate: Date | null = FUTURE,
) => ({
  status,
  total,
  dueDate,
  payments: paid.map((amount) => ({ amount, status: "PAID" })),
});

describe("D2a: statementOutstandingAmount is a status-free sum", () => {
  const mixes = {
    "SENT + VIEWED + PARTIAL + OVERDUE with payments": [
      row("SENT", 100.1),
      row("VIEWED", 50, [20.05]),
      row("PARTIAL", 300, [100, 0.1], PAST),
      row("OVERDUE", 75.35, [], PAST),
    ],
    "an overpaid invoice adds 0 and float dust reads zero": [
      row("SENT", 50, [60]),
      row(
        "SENT",
        1.1,
        Array.from({ length: 11 }, () => 0.1),
      ),
      row("PARTIAL", 0.3, [0.1, 0.1]),
    ],
    empty: [],
  } as const;

  it.each(Object.entries(mixes))("%s: equals summarizeOpenInvoices unpaidTotal", (_n, rows) => {
    const cutoff = overdueCutoff(NOW, null);
    const sum = statementOutstandingAmount(rows as any, null, NOW);
    expect(sum).toBe(summarizeOpenInvoices(rows as any, cutoff).unpaidTotal);
  });

  it("observed values", () => {
    const cutoff = overdueCutoff(NOW, null);
    const got = Object.values(mixes).map((rows) => [
      statementOutstandingAmount(rows as any, null, NOW),
      summarizeOpenInvoices(rows as any, cutoff).unpaidTotal,
    ]);
    expect(got).toEqual([
      [405.3, 405.3],
      [0.1, 0.1],
      [0, 0],
    ]);
  });

  it("does not select by status: a DRAFT row is summed as given (the caller selected it)", () => {
    expect(statementOutstandingAmount([row("DRAFT", 80), row("SENT", 20)] as any, null, NOW)).toBe(
      100,
    );
  });
});

describe("D3 count pin: every S9 reader keeps joining the open-balance / receivable-draft clause", () => {
  const SRC = path.resolve(__dirname, "..");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const uses = (rel: string, name: string) =>
    (
      strip(fs.readFileSync(path.join(SRC, rel), "utf8")).match(
        new RegExp("(?<![A-Za-z0-9_])" + name + "(?![A-Za-z0-9_])", "g"),
      ) ?? []
    ).length;

  // [file, identifier, minimum uses (the import counts as one)]
  it.each([
    ["customers/customer-statement.ts", "OPEN_BALANCE_INVOICE_WHERE", 3], // import + buildMyStatement + buildOperatorStatement
    ["customers/account-statement.ts", "OPEN_BALANCE_INVOICE_WHERE", 2], // import + buildAccountStatement
    ["customers/open-balance-basis.ts", "RECEIVABLE_DRAFT_WHERE", 2], // definition + the open-balance where
    ["customers/open-balance-basis.ts", "OPEN_BALANCE_INVOICE_WHERE", 1], // definition
    ["customers/open-balances.ts", "OPEN_BALANCE_INVOICE_WHERE", 2], // import + the read
    ["bookkeeping/bookkeeping.service.ts", "RECEIVABLE_DRAFT_WHERE", 3], // import + getArAgingInvoices + getCustomerBalanceSummary
  ] as const)("%s uses %s at least %i times", (rel, name, min) => {
    expect(uses(rel, name)).toBeGreaterThanOrEqual(min);
  });
});
