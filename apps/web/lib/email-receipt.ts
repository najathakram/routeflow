import { API_ERROR_CODES, isInternalEmail } from "@routeflow/types";

/**
 * Digital receipt (SA-751r): the pure rules of the "Email receipt" control. The copy is the UX brief's, word for word, and it is
 * FIXED: a server message is never shown (an error is told by its code), and a failure never invents a reason.
 */
export const RECEIPT_EMAIL_COPY = {
  button: "Email receipt",
  placeholder: "name@example.com",
  fieldLabel: "Email address",
  send: "Send",
  sending: "Sending…",
  sendAgain: "Send again",
  tryAgain: "Try again",
  invalid: "Check the email address.",
  failed: "Couldn't send. Try again.",
  orderLimit: "This receipt reached its email limit.",
  dayLimit: "Today's email limit is reached. Print instead.",
  unavailable: "This sale can't be emailed any more.",
  offline: "You're offline. Print it, or send it later from Today's sales.",
  sent: (to: string) => `Sent to ${to}.`,
} as const;

/**
 * Mirrors the server's `@IsEmail` (validator.js) closely enough that a valid-looking address is never refused for its shape
 * and an obviously bad one never costs a request: dot-separated atoms, one @, dot-separated labels, a 2+ character ending.
 */
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
const ADDRESS = new RegExp(`^${ATOM}(?:\\.${ATOM})*@(?:${LABEL}\\.)+[\\p{L}\\p{N}-]{2,}$`, "u");

export function isValidReceiptEmail(raw: string): boolean {
  const s = raw.trim();
  return s.length <= 254 && ADDRESS.test(s);
}

/**
 * What the row opens with. A named customer's own address; a walk-in (the shared walk-in record) or an internal placeholder
 * address (`no-email+…@placeholder.local`) is NOT an address anyone can read a receipt at, so the field opens empty. A pre-fill
 * is a suggestion the cashier presses Send on: it is never sent on its own.
 */
export function receiptEmailPrefill(
  customer: { email?: string | null; isWalkIn?: boolean | null } | null | undefined,
): string {
  if (!customer || customer.isWalkIn) return "";
  const email = (customer.email ?? "").trim();
  return email && !isInternalEmail(email) ? email : "";
}

/** How a failed send is told. Anything that is not a limit is "failed": the cashier can try again. */
export type ReceiptEmailFailure = "orderLimit" | "dayLimit" | "unavailable" | "failed";

/** The phases no retry can fix: a limit, or a sale voided after the view opened. No Send / Try again control is shown for them. */
export function isFinalReceiptEmailPhase(phase: string): boolean {
  return phase === "orderLimit" || phase === "dayLimit" || phase === "unavailable";
}

export function receiptEmailFailureOf(err: unknown): ReceiptEmailFailure {
  const data = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data;
  if (data?.code === API_ERROR_CODES.RECEIPT_EMAIL_ORDER_LIMIT) return "orderLimit";
  if (data?.code === API_ERROR_CODES.RECEIPT_EMAIL_DAY_LIMIT) return "dayLimit";
  if (data?.code === API_ERROR_CODES.RECEIPT_NOT_AVAILABLE) return "unavailable";
  return "failed";
}
