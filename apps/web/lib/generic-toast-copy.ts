import { API_ERROR_CODES } from "@routeflow/types";
import {
  CREDIT_NOTE_ERROR_COPY,
  RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
  UNCONFIRMED_COPY,
  noResponse,
} from "./credit-note-error-copy";
import { KNOWN_SERVER_SENTENCES } from "./customer-form-error-copy";
import { parsePlanGate } from "./plan-gate";
import { safeTextErrorCopy } from "./safe-text-error-copy";

/**
 * B980 (owner rule: no raw strings in the UI): the app-wide mutation error toast shows FIXED copy,
 * chosen by the server's `body.code`, then a closed allow-list of server sentences that are already
 * product text, then the HTTP status class. It never renders `response.data.message`, an axios
 * "Request failed with status code …", or an array of class-validator strings. A number ("Only N
 * left") comes from a STRUCTURED body field, never parsed out of the message.
 *
 * Mutations that render their own error UI opt out with `meta: { localErrorToast: true }`
 * (see mutation-error-toast.ts).
 */

/** Daily-work refusals, by `body.code`. The sentences name the cause and the next step. */
const CODE_COPY: Record<string, string> = {
  [API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM]: RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
  INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED:
    "This item was already returned. Add a reason to confirm another return.",
  INLINE_RETURN_KEY_CONFLICT: "This return was already submitted. Refresh to see it.",
  INLINE_RETURN_KEY_TAKEN: "This return was already submitted. Refresh to see it.",
  INLINE_RETURN_ORDER_CANCELLED: "That order is cancelled, so it can't take a return.",
  INLINE_RETURN_ORDER_CUSTOMER_MISMATCH: "That order belongs to a different customer.",
  UNIT_AWARE_LINE:
    "A line on this order is sold by a unit such as a case, so this action isn't available for it yet.",
  MERGE_PACK_MISMATCH:
    "The pack size on this order no longer matches the product. Refresh and review the line.",
  ORDER_CHANGED_DURING_EDIT: "This order changed while you were editing it. Refresh and try again.",
  [API_ERROR_CODES.ORDER_LINE_CHANGED]:
    "A line on this order changed while it was being billed. Nothing was billed. Try again.",
  CONCURRENT_UPDATE: "Someone else is updating this record. Try again in a moment.",
  MERGE_IN_PROGRESS: "Another change for this customer is in progress. Try again in a moment.",
  LOCK_UNAVAILABLE: "This is busy right now. Try again in a moment.",
  [API_ERROR_CODES.BARCODE_TAKEN]: "Another product already uses that barcode.",
  [API_ERROR_CODES.DUPLICATE_VENDOR_BILL]: "That vendor bill already exists.",
  PO_ALREADY_BILLED: "That purchase order already has a bill.",
  BILL_EXCEEDS_PO: "That bill is more than the purchase order allows.",
  INVOICE_HAS_UNSPENT_CREDIT:
    "This invoice has unspent credit. Release or use it first, then try again.",
  HANDOFF_CODE_INVALID: "This sign-in link is invalid or has expired. Sign in again.",
};

/** Exact server sentences (already product text) for refusals with no `code`; matched whole, never partially. */
const KNOWN_REFUSAL_SENTENCES: Record<string, string> = {
  "Cannot duplicate an order-linked invoice. Create a new invoice or issue a credit note instead.":
    "This invoice came from an order, so it can't be duplicated. Create a new invoice or issue a credit note instead.",
};

const PLAN_COPY = "This isn't included in your current plan.";
const READ_ONLY_COPY = "Your workspace is read-only, so this action is unavailable.";
const GENERIC_COPY = "Something went wrong. Please try again.";

function statusCopy(status: number): string {
  if (status === 400 || status === 422)
    return "Some details aren't valid. Check what you entered and try again.";
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That item no longer exists. Refresh and try again.";
  // Most uncoded 409s are "already exists / in use": say that, not "stale data".
  if (status === 409)
    return "That conflicts with something that already exists or is in use. Check it and try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return "Something went wrong on our side. Please try again.";
  return GENERIC_COPY;
}

/**
 * ONE numberless sentence for every INSUFFICIENT_STOCK body shape. `available`/`requested` count
 * PIECES with no unit noun, so "Only N left" would overstate stock to a box buyer; #2871's builder
 * (which knows the unit and the product name) replaces this when it lands.
 */
const STOCK_COPY = "Some items aren't available in that quantity.";

/** A server sentence that is already product text, matched WHOLE against the two closed tables. */
function sentenceForMessage(data: Record<string, unknown>): string | null {
  const message = data.message;
  if (typeof message !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(KNOWN_SERVER_SENTENCES, message))
    return KNOWN_SERVER_SENTENCES[message];
  if (Object.prototype.hasOwnProperty.call(KNOWN_REFUSAL_SENTENCES, message))
    return KNOWN_REFUSAL_SENTENCES[message];
  return null;
}

/** The fixed sentence a generic mutation toast shows for `err`. */
export function genericToastCopy(err: unknown): string {
  const refusal = safeTextErrorCopy(err);
  if (refusal) return refusal;
  if (!err || typeof err !== "object") return GENERIC_COPY;
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  // No HTTP response: a timeout or dropped connection may have committed; a plain client Error did not.
  if (!response) return noResponse(err) ? UNCONFIRMED_COPY : GENERIC_COPY;
  const data = (response.data && typeof response.data === "object" ? response.data : {}) as Record<
    string,
    unknown
  >;
  const gate = parsePlanGate(err);
  if (gate && gate.code !== API_ERROR_CODES.PLAN_GATE_UNAVAILABLE) return PLAN_COPY;
  const code = typeof data.code === "string" ? data.code : "";
  if (code === API_ERROR_CODES.ADDON_GATE) return PLAN_COPY;
  if (code === API_ERROR_CODES.READ_ONLY) return READ_ONLY_COPY;
  if (code === API_ERROR_CODES.INSUFFICIENT_STOCK) return STOCK_COPY;
  if (Object.prototype.hasOwnProperty.call(CREDIT_NOTE_ERROR_COPY, code))
    return CREDIT_NOTE_ERROR_COPY[code as keyof typeof CREDIT_NOTE_ERROR_COPY];
  if (Object.prototype.hasOwnProperty.call(CODE_COPY, code)) return CODE_COPY[code];
  const known = sentenceForMessage(data);
  if (known) return known;
  return typeof response.status === "number" ? statusCopy(response.status) : GENERIC_COPY;
}
