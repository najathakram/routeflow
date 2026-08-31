/**
 * F03 — the CONFIRMED payment predicate.
 *
 * A payment "counts" toward paid amounts, invoice status, dashboards, and
 * customer-facing documents ONLY once an operator has confirmed it
 * (`InvoicePayment.status === "PAID"`). DRAFT rows (e.g. an unconfirmed bulk
 * bank-reconciliation import) and VOID rows (a bounced check, a manual void)
 * must never be folded into a money-summing read.
 *
 * `status: { not: "VOID" }` was the historical (buggy) shorthand for "counts as
 * paid" across ~15 sites in this file and its siblings (bookkeeping dashboards,
 * the invoice PDF, reminder/send emails) — it silently counted an unconfirmed
 * DRAFT payment as collected money. See B11/B57/B74/B81/B84/B85/B97/B102/B103
 * in the bug register and campaign batch F03
 * (.claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md).
 *
 * LISTING reads (the raw payments array shown to an operator/customer) keep
 * the broader `not: VOID` filter — a DRAFT row must stay VISIBLE so the UI can
 * render its "Draft — unconfirmed" badge (R2). Only the SUM that drives
 * balanceDue / invoice status / dashboards / documents narrows to this
 * predicate. Do not use this to replace a listing's `not: VOID` filter.
 */
export const CONFIRMED_PAYMENT = { status: "PAID" } as const;

export interface ConfirmablePaymentRow {
  // `unknown` (not `number | string`) so a Prisma row's `amount: Decimal` — the
  // actual runtime type on every InvoicePayment read in this codebase — is
  // assignable without importing Prisma's Decimal type here. `Number(...)`
  // accepts it the same way every other money-summing site in invoices.service.ts
  // already does.
  amount: unknown;
  status: string;
}

/**
 * Sum the `amount` of only the CONFIRMED (PAID) rows in a payments array.
 * Tolerant of `null`/`undefined` so a caller can pass a relation that wasn't
 * included on a given query without an extra guard at every call site.
 */
export function sumConfirmed(
  payments: ReadonlyArray<ConfirmablePaymentRow> | null | undefined,
): number {
  return (payments ?? [])
    .filter((p) => p.status === CONFIRMED_PAYMENT.status)
    .reduce((sum, p) => sum + Number(p.amount), 0);
}
