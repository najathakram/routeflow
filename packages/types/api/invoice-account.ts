/**
 * SA-1197 (C12): the invoice's account block, one contract for the api and the web. The customer's open balance on
 * the statement's own basis prints under Balance Due when the tenant turns `invoice.showAccountBalance` on.
 *
 * The server builds every row (`accountBlockRows` in apps/api/src/customers/invoice-account-balance.ts): a screen or a
 * document prints `label` and `amount` as given and never adds, compares or picks a form (L-119). Every word the
 * customer reads lives in INVOICE_ACCOUNT_LABELS below; the api keeps a set-equal mirror (it may not load a runtime value
 * from this package, no-runtime-types-import.spec.ts), pinned by invoice-account-balance.labels.spec.ts. `{date}` is the
 * render day in the tenant's zone. No label carries "Total", "Amount due" or a second "Balance due" (owner 10-24).
 */
export const INVOICE_ACCOUNT_LABELS = {
  heading: "Your account on {date}",
  others: "Other unpaid invoices",
  thisInvoice: "This invoice",
  openBalance: "Open balance",
  /** The single line when the tenant hides Balance Due (SA-1197 Q6 (c)). */
  openBalanceOn: "Open balance on {date}",
} as const;

export type InvoiceAccountRowKind = keyof typeof INVOICE_ACCOUNT_LABELS;

/** One printed row. `amount` is null on the heading only. */
export interface InvoiceAccountRow {
  kind: InvoiceAccountRowKind;
  label: string;
  amount: number | null;
}
