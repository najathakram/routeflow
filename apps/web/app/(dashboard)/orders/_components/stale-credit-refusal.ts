import { API_ERROR_CODES } from "@routeflow/types";
import { CREDIT_NOTE_ERROR_COPY } from "@/lib/credit-note-error-copy";

/**
 * Copy for the order-create refusal a stale credit note produces. The API validates
 * `appliedCreditNotes` at submit (credit-notes.service.ts `validateSelectionsForCustomer`) and
 * refuses a missing, duplicate, voided, expired or cross-customer selection with
 * `CREDIT_NOTE_UNAVAILABLE` (B1204). The web matches the CODE only and never shows `message`.
 */
export const STALE_CREDIT_COPY = CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_UNAVAILABLE];

export function isStaleCreditRefusal(err: unknown): boolean {
  const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return code === API_ERROR_CODES.CREDIT_NOTE_UNAVAILABLE;
}
