import { API_ERROR_CODES, type CreditNoteErrorCode } from "@routeflow/types";

/**
 * #2418 U1 (owner rule: no raw server strings in the UI): every credit-note edit / reissue / void
 * refusal is shown as FIXED copy chosen by the server's `body.code` (the closed CREDIT_NOTE_* set).
 * The server `message` is never read here. A missing or unknown code falls back to the caller's
 * generic line. `Record<CreditNoteErrorCode, string>` makes a new code without copy a compile error.
 * apps/mobile/lib/credit-note-error-copy.ts carries the SAME map (a spec pins them equal).
 */
export const CREDIT_NOTE_ERROR_COPY: Record<CreditNoteErrorCode, string> = {
  [API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE]:
    "This credit note is void, so it can't be changed.",
  [API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED]:
    "This credit backs a return. Change it from the return instead.",
  [API_ERROR_CODES.CREDIT_NOTE_CREDIT_CONSUMED]:
    "Part of this credit has been used somewhere it can't be taken back from here. Nothing was changed.",
  [API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM]:
    "That amount is more than the source invoice still allows to be credited.",
  // On the CREDIT-NOTE screens this code means editing a note whose invoice was deleted (B949 / #2848); the invoice and order
  // screens, where a restore is refused, show the server's staff message ("Void that credit note first, then try again").
  [API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE]:
    "This credit note came from a deleted invoice, so it can't be changed. Void it instead.",
  [API_ERROR_CODES.CREDIT_NOTE_NO_SOURCE_CAP]:
    "A credit without a source invoice can't be increased. Issue a separate credit instead.",
  [API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY]:
    "This credit note was changed by someone else at the same time. Nothing was changed. Please try again.",
  [API_ERROR_CODES.CREDIT_NOTE_KEY_REUSED]:
    "This edit was already submitted with different details. Close this window and start again.",
  [API_ERROR_CODES.CREDIT_NOTE_KEY_REQUIRED]:
    "Something went wrong sending this edit. Please try again.",
  [API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST]: "The expiry date must be in the future.",
  [API_ERROR_CODES.CREDIT_NOTE_EXPIRY_NOT_EDITABLE]:
    "The expiry can only be changed while the credit note is still unused.",
  [API_ERROR_CODES.CREDIT_NOTE_LINES_REQUIRED]:
    "This credit is split across invoice lines. Enter an amount for each line.",
  [API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID]:
    "One of the credit lines isn't valid. Check each line amount.",
};

/** Shown when the request got no response at all (a timeout or a dropped connection): it may have committed. */
export const UNCONFIRMED_COPY =
  "We couldn't confirm whether this went through. Refresh and check before trying again.";

/** A request that left but got no HTTP response (timeout / network error): the server may have committed. */
export function noResponse(err: unknown): boolean {
  const e = err as {
    response?: unknown;
    request?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
  if (!e || typeof e !== "object" || e.response !== undefined) return false;
  return e.request !== undefined || e.code === "ECONNABORTED" || e.message === "Network Error";
}

/**
 * The fixed copy for an error's `response.data.code`; a timeout / network error (no response, the write
 * may have gone through) is the "couldn't confirm" line; anything else is `fallback`. Never the server message.
 */
export function creditNoteErrorCopy(err: unknown, fallback: string): string {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  if (
    typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(CREDIT_NOTE_ERROR_COPY, code)
  )
    return CREDIT_NOTE_ERROR_COPY[code as CreditNoteErrorCode];
  return noResponse(err) ? UNCONFIRMED_COPY : fallback;
}

/** The fixed copy for a void-preview `refusalCode`; a missing/unknown code is the generic refusal line. */
export function refusalCopy(code: string | null | undefined): string {
  return creditNoteErrorCopy(
    { response: { data: { code } } },
    "This can't be changed right now. Nothing was changed.",
  );
}

/** SA-628 (B946): the refund of a return that would credit a line past its value (a credit note or an earlier refund already took part of it). */
export const RETURN_REFUND_OVER_LINE_HEADROOM_COPY =
  "This refund would credit more than the invoice line is worth, because part of it was already credited (by a credit note or an earlier refund). Refund it outside RouteFlow, or issue the credit note manually.";

/** B965: a standard return of a product that was sold on lines with different pack sizes has no single piece count to refund. */
export const RETURN_MIXED_UNIT_PRODUCT_COPY =
  "This product was sold in different units on this order (for example boxes and loose pieces), so RouteFlow can't price this return as one quantity. Credit it per line with an inline return, or refund it manually.";

/** B959: nothing the customer returned was billed on the order. */
export const RETURN_NOTHING_BILLED_COPY =
  "None of the returned items were billed on this order, so there is nothing to refund. Cancel the return, or credit it manually if a refund is owed.";

/** The refund toast text: the fixed copy for RETURN_REFUND_OVER_LINE_HEADROOM, RETURN_NOTHING_BILLED and RETURN_MIXED_UNIT_PRODUCT (by `response.data.code`), else the caller's own text. */
export function refundErrorMessage(err: unknown, otherwise?: string): string | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  if (code === API_ERROR_CODES.RETURN_NOTHING_BILLED) return RETURN_NOTHING_BILLED_COPY;
  if (code === API_ERROR_CODES.RETURN_MIXED_UNIT_PRODUCT) return RETURN_MIXED_UNIT_PRODUCT_COPY;
  return code === API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM
    ? RETURN_REFUND_OVER_LINE_HEADROOM_COPY
    : otherwise;
}
