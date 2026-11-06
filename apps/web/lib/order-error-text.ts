import { API_ERROR_CODES } from "@routeflow/types";
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
 * SA-1101 A-5 (B1272): the office "Reopen order" / demotion out of DELIVERED refused with 409 ORDER_HAS_RETURN. The same code
 * means "deliver it again" on a refused order (generic-toast-copy.ts), so this action says its own fixed sentence, the same
 * pattern as `stopUndoErrorCopy` (B986: never rendered from the response).
 */
export const DEMOTE_HAS_RETURN_COPY =
  "This order has a return. To change its delivery status, cancel the return first.";

/**
 * B1280: the other two ways "Reopen order" is refused. Each has its own code, and the walk-in code is the one the order
 * EDIT uses too ("Ring up added items as a new sale"), which reads wrong on a reopen, so this action says its own sentence.
 */
export const DEMOTE_WALK_IN_PAID_COPY =
  "This counter sale is paid, so it can't be reopened. To take items back, use Return.";
export const DEMOTE_ON_ROUTE_RUN_COPY =
  "This order was delivered on a route run. Undo its stop on the run, which also reverses stock and payments.";

const demoteCopyFor = (err: unknown): string | null => {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  if (res?.status !== 409) return null;
  switch (res.data?.code) {
    case API_ERROR_CODES.ORDER_HAS_RETURN:
      return DEMOTE_HAS_RETURN_COPY;
    case API_ERROR_CODES.WALK_IN_SALE_PAID:
      return DEMOTE_WALK_IN_PAID_COPY;
    case API_ERROR_CODES.ORDER_ROUTE_STOP_COMPLETED:
      return DEMOTE_ON_ROUTE_RUN_COPY;
    default:
      return null;
  }
};

/** True for any Reopen order refusal this page words itself (the global toast stays silent for these). */
export const isDemoteRefusal = (err: unknown): boolean => demoteCopyFor(err) !== null;

/** The demotion's own sentence for a Reopen order refusal, or null for any other error (the global toast keeps those). */
export const demoteErrorText = (err: unknown): string | null => demoteCopyFor(err);

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
