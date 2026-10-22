import {
  RECORD_ANYWAY_LABEL,
  canRecordAnyway,
  duplicatePaymentRefBody,
  duplicatePaymentRefCopy,
} from "@routeflow/types/payment-ref-copy";

/**
 * Row 498 (SA-837), mobile: 409 DUPLICATE_PAYMENT_REF on a record-payment Save (mirrors web's
 * `lib/duplicate-payment-ref.ts`). Nothing was written. The prompt names the existing payment with the ONE shared
 * sentence and, for a staff role, offers "Record anyway", which resends the SAME form with `recordAnyway: true`.
 * Pure: the screens turn it into an Alert.
 */
export interface DuplicateRefPrompt {
  title: string;
  message: string;
  /** The action label, or null when this role is not offered the resend (the server ignores the flag for it). */
  recordAnywayLabel: string | null;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtMoney = (n: number) => `$${n.toFixed(2)}`;

/** The prompt for a 409 DUPLICATE_PAYMENT_REF error, or null for any other error. */
export function duplicateRefPrompt(
  err: unknown,
  role: string | null | undefined,
): DuplicateRefPrompt | null {
  const body = duplicatePaymentRefBody(err);
  if (!body) return null;
  return {
    title: "Possible duplicate payment",
    message: duplicatePaymentRefCopy(body.existingPayment, { date: fmtDate, money: fmtMoney }),
    recordAnywayLabel: canRecordAnyway(role) ? RECORD_ANYWAY_LABEL : null,
  };
}
