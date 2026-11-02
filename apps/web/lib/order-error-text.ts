import { codedToastCopy, genericToastCopy } from "./generic-toast-copy";

/**
 * The text an order delete refusal shows (B986-7). A recognised body code is fixed copy; an UNCODED refusal keeps the
 * server's own sentence, because it names what to fix ("void the invoice first") and no fixed sentence is as specific
 * until the endpoint sends a code (B991 / B987-E). Never axios's "Request failed with status code …": with no usable
 * server sentence it falls to the fixed generic copy. The sentence passes through ONLY for 400 / 404 / 409 / 422: a 5xx or a
 * 403 carries a framework string ("Internal server error", "Forbidden resource") that must never reach the user.
 */
const SENTENCE_STATUSES = new Set([400, 404, 409, 422]);

export function orderErrorText(err: unknown): string {
  const coded = codedToastCopy(err);
  if (coded) return coded;
  const response = (err as { response?: { status?: number; data?: { message?: unknown } } } | null)
    ?.response;
  const message = response?.data?.message;
  if (SENTENCE_STATUSES.has(response?.status ?? 0) && typeof message === "string" && message.trim())
    return message;
  return genericToastCopy(err);
}

/**
 * Orders list, bulk delete: the toast when some of the selected orders were kept. The server refuses an order for more
 * than one reason (recorded payments, delivered items, a cash refund), so the line names the two the user can act on
 * and does not claim a single cause. Row 585.
 */
export const bulkDeleteResultTitle = (deleted: number, kept: number): string =>
  `${deleted} deleted, ${kept} kept. An order with delivered items needs a return first; one with recorded payments needs them voided first.`;

/** Order detail "mark as sent": fixed copy, with this surface's own sentence for an uncoded 400 / 409 / 422. */
export const markSentErrorText = (err: unknown): string =>
  genericToastCopy(
    err,
    "The invoice couldn't be marked as sent. Check its status, then try again.",
  );

/** Order detail "email the invoice": fixed copy, with this surface's own sentence for an uncoded 400 / 409 / 422. */
export const sendEmailErrorText = (err: unknown): string =>
  genericToastCopy(
    err,
    "The email couldn't be sent. Check the customer's email address, then try again.",
  );
