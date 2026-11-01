import type { AccountStatement, AccountStatementInvoice } from "@routeflow/types";

/** The sheet shows the oldest 200 open invoices; the PDF has them all. */
export const STATEMENT_SCREEN_ROWS = 200;

/** SA-1078 words, in one place so the sheet, its pins and the Mac mini proof read the same text. */
export const STATEMENT_COPY = {
  title: "Statement",
  openBalance: "Open balance",
  overdue: "Overdue",
  creditAvailable: "Credit available",
  afterCredit: "After credit",
  waitingToClear: "Waiting to clear",
  openInvoices: "Open invoices",
  recentPayments: "Paid in the last 30 days",
  credits: "Credits",
  noOpenInvoices: "No open invoices",
  loadFailed: "Couldn't load the statement.",
  tryAgain: "Try Again",
  viewStatement: "View statement",
  print: "Print",
  printOrShare: "Print or share",
  openPdf: "Open PDF",
  printFailedTitle: "Couldn't print the statement",
  printFailedBody: "Try again.",
  email: "Email",
  sendTo: "Send to",
  send: "Send",
  emailNotSetUp: "Email isn't set up yet. An account admin can set it up under Settings → Email.",
  emailFailed: "Couldn't send the statement. Check the address and try again.",
} as const;

/** "Statement sent to ap@acme.test" */
export const sentToLabel = (address: string): string => `Statement sent to ${address}`;

export const daysLateLabel = (n: number): string => (n === 1 ? "1 day late" : `${n} days late`);

/** "Showing 200 of 250. The PDF has them all." — only when the screen cut the list. */
export const showingLabel = (shown: number, total: number): string =>
  `Showing ${shown} of ${total}. The PDF has them all.`;

/**
 * Who is offered the figure as a button: any staff but an operator whose admin switched off both FINANCE and CUSTOMERS (the
 * server's `FINANCE|CUSTOMERS`). Drivers, buyers and a role not yet known get the plain figure.
 */
export function mayOpenStatement(
  role: string | null | undefined,
  deniedGroups: readonly string[],
  opts: { permissionsKnown: boolean },
): boolean {
  if (role === "TENANT_ADMIN") return true;
  if (role !== "OPERATOR" || !opts.permissionsKnown) return false;
  return !(deniedGroups.includes("FINANCE") && deniedGroups.includes("CUSTOMERS"));
}

export interface StatementShape {
  rows: AccountStatementInvoice[];
  total: number;
  cut: boolean;
  showCreditColumn: boolean;
  showCreditLines: boolean;
  showWaiting: boolean;
  empty: boolean;
}

/** What the sheet shows of a statement: the oldest 200 open invoices, and only the columns and lines that carry a value. */
export function statementShape(s: AccountStatement): StatementShape {
  const total = s.openInvoices.length;
  return {
    rows: s.openInvoices.slice(0, STATEMENT_SCREEN_ROWS),
    total,
    cut: total > STATEMENT_SCREEN_ROWS,
    showCreditColumn: s.openInvoices.some((r) => r.credit > 0),
    showCreditLines: s.creditAvailable > 0,
    showWaiting: s.waitingToClear > 0,
    empty: total === 0,
  };
}
