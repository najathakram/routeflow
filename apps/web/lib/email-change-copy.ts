import { API_ERROR_CODES } from "@routeflow/types";

/**
 * B461 (SA-1116): the words for a held login-email change. The server answers with a `code`; the page shows the fixed
 * sentence for it and never the server's message (the same pattern as `user-status-refusal.ts`).
 */
export const EMAIL_CHANGE_PENDING_COPY = "Waiting for the new address to confirm";

export const EMAIL_CHANGE_SENT_COPY =
  "We sent a link to the new address. The email changes once it confirms.";

export const EMAIL_CHANGE_REFUSAL_COPY = {
  [API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID]:
    "This link has expired, was already used, or was replaced. Ask for the email change again.",
  [API_ERROR_CODES.EMAIL_TAKEN]:
    "Another account already uses this address. Choose a different email.",
} as const;

/** The sentence for a refused confirm. An unknown code, or none, reads as an invalid link. */
export function emailChangeRefusalCopy(code: unknown): string {
  const copy = EMAIL_CHANGE_REFUSAL_COPY as Record<string, string>;
  return (
    (typeof code === "string" ? copy[code] : undefined) ??
    copy[API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID]
  );
}
