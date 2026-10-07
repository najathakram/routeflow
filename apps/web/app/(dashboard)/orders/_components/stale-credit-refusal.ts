/**
 * Copy for the order-create refusal a stale credit note produces.
 *
 * The API validates `appliedCreditNotes` at submit (credit-notes.service.ts
 * `validateSelectionsForCustomer`, called from orders.service.ts create) and refuses a missing,
 * duplicate, expired or cross-customer selection with a plain 400/404 whose body has NO `code`.
 * The web must never show that server sentence (owner rule: fixed copy only).
 *
 * TODO(B1204): B1204 gives this refusal a proper API code; then match on the code and delete the
 * status + credits-sent heuristic below (no message text is read: B986 raw-message ratchet).
 */
export const STALE_CREDIT_COPY =
  "A credit note you picked is no longer available. Remove it and try again.";

export function isStaleCreditRefusal(err: unknown, creditsSent: number): boolean {
  if (creditsSent <= 0) return false;
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
  if (!res || (res.status !== 400 && res.status !== 404)) return false;
  if (res.data?.code) return false; // a coded refusal has its own copy path
  return true;
}
