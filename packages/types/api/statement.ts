// ─── Customer account statement: the DTO (web, mobile, PDF and API) ─────────────────────────────────────────────────
//
// SA-1078 (W-1096). One read answers "what does this customer owe us, on which invoices, what was paid and what was
// not". Every figure is the server's, in dollars rounded to the cent; the screens never add, net or clamp. The API
// imports this type-only (L-261), and the numbers come from `summarizeOpenInvoices`, so `openBalance` is the sum of
// the `unpaid` column and equals the figure the customer page shows.
//
// Routes: `GET /customers/:id/account-statement` (staff) and `GET /buyer/account-statement` (the buyer's own view,
// which omits `emailOnFile` and every `toCollect`).

import type { ToCollectState } from "./enums";

/** One invoice that still owes. Oldest first. Overpaid, exactly-paid, draft, void and written-off invoices are not rows. */
export interface AccountStatementInvoice {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  total: number;
  /** confirmed money applied to this invoice (a DRAFT or VOID payment is not money) */
  paid: number;
  /** credit notes, returns and advances applied to this invoice */
  credit: number;
  /** total − paid − credit, clamped at 0 and rounded to the cent */
  unpaid: number;
  /** whole days past the due date in the tenant's zone; 0 when due today, not yet due or no due date */
  daysLate: number;
  /** staff route only */
  toCollect?: ToCollectState;
}

/** One confirmed payment or credit in the last 30 days, on any invoice (a paid invoice still shows its payment). */
export interface AccountStatementPayment {
  date: string;
  kind: "PAYMENT" | "CREDIT";
  method: string;
  reference: string | null;
  invoiceNumber: string;
  amount: number;
}

/** An unused credit note or an advance with a balance. Omitted when there are none. */
export interface AccountStatementCredit {
  kind: "CREDIT_NOTE" | "ADVANCE";
  id: string;
  number: string | null;
  date: string;
  reason: string | null;
  /** what is left to use */
  remaining: number;
  expiresAt: string | null;
}

export interface AccountStatement {
  /** the tenant-zone day the figures are read at */
  asOf: string;
  customer: { id: string; businessName: string };
  /** staff route only */
  emailOnFile?: string | null;
  /** sum of `openInvoices[].unpaid`; never nets credit */
  openBalance: number;
  /** the part of `openBalance` past its due date; never above `openBalance` */
  overdue: number;
  /** unused credit notes plus advances with a balance */
  creditAvailable: number;
  /** `openBalance` less `creditAvailable`, not below 0 */
  afterCredit: number;
  /** post-dated checks held, not counted as paid yet */
  waitingToClear: number;
  openInvoices: AccountStatementInvoice[];
  recentPayments: AccountStatementPayment[];
  /** true when more than 50 payments fell in the last 30 days and the list was cut */
  recentPaymentsTruncated: boolean;
  credits: AccountStatementCredit[];
}
