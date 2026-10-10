import { overdueCutoff } from "../common/calendar-date";
import { computeDepositFields } from "./deposit-fields";
import { classifyInvoiceBalance } from "./invoice-balance-classify";
import { splitConfirmed } from "./payment-predicates";

/**
 * The derived read-time fields of InvoicesService.findOne (moved verbatim out of invoices.service.ts,
 * #2717, to keep the size ratchet's ceiling): the confirmed-payment split, balance due, overdue and
 * the deposit fields. `inv` is the loaded invoice with its `payments`.
 */
export function deriveInvoiceDetailFields(inv: any, now: Date = new Date()) {
  // F03/R1: CONFIRMED (PAID) payments only. VOID payments (manually voided OR
  // bounced checks) must not count toward the paid amount - and neither must an
  // unconfirmed DRAFT one; every other paid-sum in this file matches.
  //
  // B421: paidAmount is CASH-ONLY; creditApplied/advanceApplied are separate
  // - see findAll's matching comment for why balanceDue/deposit still use
  // the full confirmed total.
  const { cash: paidAmount, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
  const totalConfirmed = paidAmount + creditApplied + advanceApplied;
  // SA-770: balance and overdue come from the ONE classifier (RF-202: invoice due today is NOT
  // overdue; the cutoff is the UTC day of `now`, as this read has always judged it).
  const { balanceDue, isOverdue } = classifyInvoiceBalance(inv, overdueCutoff(now));
  const todayIso = now.toISOString().slice(0, 10);
  const { depositAmount, depositOverdue } = computeDepositFields(inv, totalConfirmed, todayIso);
  return {
    balanceDue,
    paidAmount,
    creditApplied,
    advanceApplied,
    isOverdue,
    depositAmount,
    depositOverdue,
  };
}
