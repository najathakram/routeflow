import { API_ERROR_CODES } from "@routeflow/types";
import { creditNoteErrorCopy } from "./credit-note-error-copy";

/**
 * Owner rule (no raw server strings in the UI), mirroring credit-note-error-copy.ts: a failed "Send reminder" is
 * shown as FIXED copy chosen by the server's `response.data.code`. The server `message` is never read. The
 * wording matches web's generic-toast-copy for the same codes. A missing or unknown code is one generic line;
 * a request that got no response at all (the email may have gone out) is the shared "couldn't confirm" line.
 */
export const REMINDER_ERROR_COPY: Record<string, string> = {
  [API_ERROR_CODES.REMINDER_NOT_ISSUED]:
    "A reminder can only be sent for an invoice that has been issued and is still unpaid.",
  [API_ERROR_CODES.REMINDER_NO_BALANCE_DUE]:
    "This invoice has no balance due, so there is nothing to remind about.",
  [API_ERROR_CODES.EMAIL_NOT_CONFIGURED]:
    "Email isn't set up for this workspace yet. Connect it under Settings → Email, then try again.",
  [API_ERROR_CODES.EMAIL_SEND_FAILED]:
    "The email couldn't be sent. Check your email settings under Settings → Email, then try again.",
};

export const REMINDER_FALLBACK_COPY = "The reminder couldn't be sent. Please try again.";

export function reminderErrorCopy(err: unknown): string {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(REMINDER_ERROR_COPY, code))
    return REMINDER_ERROR_COPY[code];
  // no-response -> the shared "couldn't confirm" line; anything else -> the generic reminder line
  return creditNoteErrorCopy(err, REMINDER_FALLBACK_COPY);
}
