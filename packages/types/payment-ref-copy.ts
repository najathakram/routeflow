import { API_ERROR_CODES } from "./api/error-codes";
import type { DuplicatePaymentRefBody, DuplicatePaymentRefExisting } from "./api/payment-ref";

/**
 * Row 498 (SA-837): the client side of 409 DUPLICATE_PAYMENT_REF, shared by web and mobile (a deep-import file like
 * payment-submit-key.ts: pure, so mobile's jest maps it by path). The wire shape is api/payment-ref.ts.
 */

type AxiosLike =
  { response?: { status?: unknown; data?: Partial<DuplicatePaymentRefBody> } } | null | undefined;

/** The body of a 409 DUPLICATE_PAYMENT_REF error, or null for any other error. */
export function duplicatePaymentRefBody(err: unknown): DuplicatePaymentRefBody | null {
  const res = (err as AxiosLike)?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.DUPLICATE_PAYMENT_REF) return null;
  return res.data.existingPayment ? (res.data as DuplicatePaymentRefBody) : null;
}

/** The ONE "record anyway" label (web and mobile). */
export const RECORD_ANYWAY_LABEL = "Record anyway";

/**
 * The ONE copy of the refusal: "A payment with this reference was already recorded on <date> for <amount>
 * (<invoice>)." The caller formats the date and the amount in its own locale; the invoice is its number, or
 * "an invoice" when the number is missing.
 */
export function duplicatePaymentRefCopy(
  existing: DuplicatePaymentRefExisting,
  fmt: { date: (iso: string) => string; money: (n: number) => string },
): string {
  return `A payment with this reference was already recorded on ${fmt.date(existing.paidAt)} for ${fmt.money(existing.amount)} (${existing.invoiceNumber ?? "an invoice"}).`;
}

/**
 * The resend of a refused Save: the same body with `recordAnyway: true`. Only a STAFF user is offered this; the
 * server ignores the flag from any other role, so the flag is a request, never a right.
 */
export function withRecordAnyway<T extends object>(body: T): T & { recordAnyway: true } {
  return { ...body, recordAnyway: true };
}

/**
 * Whether the signed-in role is offered "Record anyway". The server decides (it ignores the flag from any other
 * role); this only keeps the action off screens of roles that could never use it.
 */
export function canRecordAnyway(role: string | null | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "TENANT_ADMIN" || role === "OPERATOR";
}
