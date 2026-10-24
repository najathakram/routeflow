/**
 * SA-777: the ONE derivation of the Billing card's / strip's state, from the tenant's OPEN Stripe invoices. Pure (no
 * I/O, no clock of its own): the server decides, the browser only renders. Precedence, highest first:
 *   processing  every owed invoice's payment is still settling (a bank debit's PaymentIntent is `processing`)
 *   overdue     Stripe has already tried (attempt_count > 0) OR an invoice is past its own due_date
 *   due         something is owed and nothing above applies
 *   current     nothing is owed
 * An invoice with nothing remaining owes nothing and is ignored (the caller filters on `open`, this guards the sum).
 */
export type BillingState = "current" | "due" | "overdue" | "processing";

/** What the derivation needs of one open invoice (Stripe's integer cents and unix seconds, never floats). */
export interface OpenInvoiceFact {
  amountRemainingCents: number;
  attemptCount: number;
  /** Stripe `due_date` (unix seconds): set for send-invoice collection only; null for charge-automatically. */
  dueDateSec: number | null;
  paymentProcessing: boolean;
  hostedInvoiceUrl: string | null;
  /** Stripe `created` (unix seconds): the oldest-first order. */
  createdSec: number;
}

const owes = (i: OpenInvoiceFact) => i.amountRemainingCents > 0;

/** The invoices that still owe money, oldest first. */
export function owedInvoices(invoices: readonly OpenInvoiceFact[]): OpenInvoiceFact[] {
  return invoices.filter(owes).sort((a, b) => a.createdSec - b.createdSec);
}

/** The owed invoices a payment can still be made on (not already settling), oldest first. */
export function payableInvoices(invoices: readonly OpenInvoiceFact[]): OpenInvoiceFact[] {
  return owedInvoices(invoices).filter((i) => !i.paymentProcessing);
}

/** Σ amount_remaining in INTEGER cents (the caller converts once, server-side, with `fromCents`). */
export function outstandingCents(invoices: readonly OpenInvoiceFact[]): number {
  return owedInvoices(invoices).reduce((s, i) => s + i.amountRemainingCents, 0);
}

/**
 * `processing` means a payment is settling and there is NOTHING ELSE to pay: when one owed invoice is processing
 * and another is still unpaid, the state is that other invoice's (overdue / due) - hiding Pay for an unpaid
 * invoice because a sibling is settling would strand it (SA-777 review).
 */
export function deriveBillingState(invoices: readonly OpenInvoiceFact[], now: Date): BillingState {
  const owed = owedInvoices(invoices);
  if (owed.length === 0) return "current";
  const payable = payableInvoices(invoices);
  if (payable.length === 0) return "processing";
  const nowSec = now.getTime() / 1000;
  if (payable.some((i) => i.attemptCount > 0 || (i.dueDateSec != null && i.dueDateSec < nowSec)))
    return "overdue";
  return "due";
}
