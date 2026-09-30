import { API_ERROR_CODES, type CreditNoteErrorCode } from "@routeflow/types";

/**
 * #2418 U1 (owner rule: no raw server strings in the UI): every credit-note edit / reissue / void
 * refusal is shown as FIXED copy chosen by the server's `body.code` (the closed CREDIT_NOTE_* set).
 * The server `message` is never read here. A missing or unknown code falls back to the caller's
 * generic line. `Record<CreditNoteErrorCode, string>` makes a new code without copy a compile error.
 * apps/web/lib/credit-note-error-copy.ts carries the SAME map (a web spec pins them equal).
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
  [API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE]:
    "The invoice this credit came from is gone or can no longer be credited.",
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

/** The fixed copy for an error's `response.data.code`, else `fallback`. Never the server message. */
export function creditNoteErrorCopy(err: unknown, fallback: string): string {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  return typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(CREDIT_NOTE_ERROR_COPY, code)
    ? CREDIT_NOTE_ERROR_COPY[code as CreditNoteErrorCode]
    : fallback;
}

/** The fixed copy for a void-preview `refusalCode`; a missing/unknown code is the generic refusal line. */
export function refusalCopy(code: string | null | undefined): string {
  return creditNoteErrorCopy(
    { response: { data: { code } } },
    "This can't be changed right now. Nothing was changed.",
  );
}
