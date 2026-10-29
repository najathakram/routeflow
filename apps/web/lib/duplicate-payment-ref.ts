import {
  API_ERROR_CODES,
  RECORD_ANYWAY_LABEL,
  canRecordAnyway,
  duplicatePaymentRefBody,
  duplicatePaymentRefCopy,
} from "@routeflow/types";
import { formatDate, formatMoney } from "@/lib/format";
import { isDayClosedRefusal } from "@/lib/day-closed-copy";

/**
 * Row 498 (SA-837): 409 DUPLICATE_PAYMENT_REF on a record-payment Save. Nothing was written. Every record-payment
 * surface (invoice, customer, finance Payments, the two bookkeeping ledgers) answers it the same way: the fixed
 * sentence naming the existing payment, and, for a staff role, a "Record anyway" action that resends the SAME form
 * with `recordAnyway: true` (the server audits it and ignores the flag for any other role).
 */

/** True for the refusal this module answers (the global error toast stays quiet for it). */
export const isDuplicatePaymentRef = (err: unknown): boolean =>
  duplicatePaymentRefBody(err) !== null;

/** `meta.localErrorToast` for the record-payment mutations: the day-close refusal and the duplicate-reference refusal. */
export const isRecordPaymentLocalRefusal = (err: unknown): boolean =>
  isDayClosedRefusal(err) || isDuplicatePaymentRef(err);

type ToastFn = (t: {
  title: string;
  description?: string;
  variant?: "error" | "warning";
  duration?: number;
  action?: { label: string; onClick: () => void };
}) => unknown;

/** The ONE sentence of the refusal, formatted for web. */
export function duplicatePaymentRefMessage(err: unknown): string | null {
  const body = duplicatePaymentRefBody(err);
  return body
    ? duplicatePaymentRefCopy(body.existingPayment, { date: formatDate, money: formatMoney })
    : null;
}

/**
 * SA-1026 D: whether resending the SAME body to a not-recorded hand-over can ever pass. A duplicate reference is a
 * deterministic refusal (the key is tenant + customer + method + reference + amount, with no time window), so a Retry of the
 * same body can never record it; every other cause (a lock timeout, a register race) can, as before.
 */
export const retryCanHelp = (outcome: { paymentCauseCode?: string | null }): boolean =>
  outcome.paymentCauseCode !== API_ERROR_CODES.DUPLICATE_PAYMENT_REF;

/**
 * Show the refusal and, for staff, the "Record anyway" action. Returns true when `err` was this refusal (the caller
 * then shows nothing else). `resend` re-submits the same form with `recordAnyway: true`.
 */
export function toastDuplicatePaymentRef(
  err: unknown,
  toast: ToastFn,
  role: string | null | undefined,
  resend: () => void,
): boolean {
  const message = duplicatePaymentRefMessage(err);
  if (!message) return false;
  toast({
    title: "Possible duplicate payment",
    description: message,
    variant: "warning",
    duration: 15000,
    ...(canRecordAnyway(role) ? { action: { label: RECORD_ANYWAY_LABEL, onClick: resend } } : {}),
  });
  return true;
}
