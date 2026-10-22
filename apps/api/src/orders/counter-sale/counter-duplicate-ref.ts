import type { DuplicatePaymentRefExisting } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { refDedupeFromRequest, type RefDedupeOpts } from "../../invoices/payment-ref-dedupe";

/**
 * SA-837b item 3 (review I3): the till's and the hand-over's escape from a duplicate payment reference. NOT a counter
 * rule: it is the generic `recordAnyway` flag of the one payment path, carried through the counter responses.
 *
 *  - `tenderRefDedupe`: the generic writer option for the signed-in cashier (actor + role from the JWT) and the request's
 *    `payment.recordAnyway`. Staff-only is the writer's rule (a non-staff role's flag is ignored there).
 *  - `duplicateOf`: the existing payment named by a 409 DUPLICATE_PAYMENT_REF thrown from the writer, else null. The
 *    counter's catch maps every tender failure to COUNTER_PAYMENT_NOT_RECORDED; this keeps WHY (and the payment) so the
 *    till can show the shared sentence and a "Record anyway" action.
 *  - `duplicateCause`: the response fields for that cause (omitted for every other failure).
 */
export function tenderRefDedupe(
  user: { sub?: string | null; role?: string | null } | undefined,
  payment: { recordAnyway?: boolean } | undefined,
): RefDedupeOpts {
  return refDedupeFromRequest(user, { recordAnyway: payment?.recordAnyway });
}

export function duplicateOf(err: unknown): DuplicatePaymentRefExisting | null {
  const res = (
    err as { getStatus?: () => number; getResponse?: () => unknown } | null
  )?.getResponse?.() as
    { code?: unknown; existingPayment?: DuplicatePaymentRefExisting } | undefined;
  if (res?.code !== API_ERROR_CODES.DUPLICATE_PAYMENT_REF) return null;
  return res.existingPayment ?? null;
}

export function duplicateCause(existing: DuplicatePaymentRefExisting | null | undefined) {
  return existing
    ? { paymentCauseCode: API_ERROR_CODES.DUPLICATE_PAYMENT_REF, existingPayment: existing }
    : {};
}
