/**
 * SA-737: the pieces of a STANDARD return's refund claim that are not the service's own pricing. The claim is ONE transaction
 * in the house lock order (counter-close, Return, Order, the order's creditable invoices id-sorted); the refund basis is
 * recomputed inside it from the locked rows, so a void or an order cancel that committed while the refund waited is seen, never
 * paid out. The store-credit mint (`creditNotes.create`, its own transaction) runs after the claim commits, never inside it.
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * How long ONE lock wait of the claim (the counter close, the Return, the Order, the invoices) gives up after, with a retryable
 * 409. `lock_timeout` is per statement, so the claim's waits add up: up to four of them, which is why the transaction below
 * gets its own budget instead of Prisma's 5 s default. An expired transaction (P2028) is mapped to the same 409.
 */
export const REFUND_LOCK_TIMEOUT_MS = 2000;

/** The claim transaction's budget: four bounded lock waits plus the recompute, the claim and the audit row. */
export const REFUND_TX_TIMEOUT_MS = 15_000;

/** Prisma's "transaction already closed / expired" error code (the budget ran out before the claim finished). */
export const isTransactionExpired = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "P2028";

/** The 400 text of "nothing billed on this order can be refunded" (the pre-claim refusal AND the one the recompute converts). */
export const NOTHING_CREDITABLE_MESSAGE = "Nothing billed on this order can be refunded";

/** The text a refund that lost the race for a return keeps (it was a 400 before the claim became a CAS under the Return lock). */
export const REFUND_ALREADY_RESOLVED_MESSAGE = "Only RECEIVED returns can be refunded";

/** The `where` of the claim: still RECEIVED, no refund recorded, no credit note minted. */
export const refundClaimWhere = (id: string) =>
  ({ id, status: "RECEIVED", refundedAt: null, creditNoteId: null }) as const;

/**
 * 409: what was billed changed while the refund waited for the locks. `NOTHING_BILLED`: an invoice was voided or the order
 * cancelled and nothing returned is billed any more. `AMOUNT`: the recorded (cash) refund would be a different figure than the
 * one the operator was shown.
 */
export function refundBasisChanged(
  kind: "NOTHING_BILLED" | "AMOUNT" = "NOTHING_BILLED",
): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.RETURN_REFUND_BASIS_CHANGED,
    message:
      kind === "AMOUNT"
        ? "The invoices for this order changed while the refund was being recorded, so the refund is now a different amount. " +
          "Nothing was refunded. Review the order and try again."
        : "The invoices for this order changed while the refund was being recorded, and nothing the customer returned is billed any more. " +
          "Nothing was refunded. Review the order, then give store credit or cancel the return.",
  });
}

/** 409: another request holds the order or its invoices; safe to retry, nothing was written. */
export function refundBusy(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.CONCURRENT_UPDATE,
    reason: "REFUND_BUSY",
    retryable: true,
    message: "Another update to this order is in progress. Try again in a moment.",
  });
}

/** 409: the return was resolved by another request while this one waited. */
export const refundAlreadyResolved = (): ConflictException =>
  new ConflictException(REFUND_ALREADY_RESOLVED_MESSAGE);

/** True when `err` is the "nothing billed" refusal of `billedBasisFor` (the plain 400, or its coded RETURN_NOTHING_BILLED form). */
export function isNothingBilledRefusal(err: unknown): boolean {
  const body = (err as { getResponse?: () => unknown } | null)?.getResponse?.();
  if (typeof body === "string") return body === NOTHING_CREDITABLE_MESSAGE;
  const { code, message } = (body ?? {}) as { code?: unknown; message?: unknown };
  return code === API_ERROR_CODES.RETURN_NOTHING_BILLED || message === NOTHING_CREDITABLE_MESSAGE;
}

/** The priced result of `priceReturn` says nothing the customer returned is billed on a creditable invoice. */
export const pricedNothingBilled = (priced: object | null | undefined): boolean => {
  const refusal = (priced as { refusal?: string } | null | undefined)?.refusal;
  return refusal === "NOTHING_CREDITABLE" || refusal === "NOTHING_BILLED";
};
