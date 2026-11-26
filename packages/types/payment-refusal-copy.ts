/**
 * SA-1299 P4 (B1396, B1385): the ONE home of the sentences staff read when a payment is refused, for web
 * (`apps/web/lib/generic-toast-copy.ts`) and mobile (`apps/mobile/lib/payment-refusal-copy.ts`), so the words
 * cannot drift. Wording by the wording architect (board 7174039419, amended 7174508881): what happened, then the
 * next step; no code shown, no blame. Pure: no React, no network.
 *
 * Staff press "Send" on the invoice page, so the DRAFT sentence says "Send".
 */
import { API_ERROR_CODES } from "./api/error-codes";

/** INVOICE_NOT_PAYABLE: one sentence per body `reason` (DRAFT, VOID, WRITTEN_OFF). */
// Each reason is its own constant on purpose: a single literal group of the three InvoiceStatus values would read as a
// hand-typed enum mirror (no-hand-typed-enum-mirrors.spec.ts). These are the wire reasons of INVOICE_NOT_PAYABLE, not a status list.
const REASON_DRAFT = "DRAFT";
const REASON_VOID = "VOID";
const REASON_WRITTEN_OFF = "WRITTEN_OFF";
export const INVOICE_NOT_PAYABLE_COPY: Record<string, string> = {
  [REASON_DRAFT]:
    "This invoice is still a draft. Send it to the customer first, then record the payment.",
  [REASON_VOID]: "This invoice is void, so it can't take a payment.",
  [REASON_WRITTEN_OFF]: "This invoice was written off, so it can't take a payment.",
};

/** INVOICE_NOT_PAYABLE with no or an unknown reason: no claim about the status. */
export const INVOICE_NOT_PAYABLE_DEFAULT_COPY = "This invoice can't take a payment right now.";

/** DRAFT_PAYMENT_HAS_EXCESS: a draft payment cannot carry a leftover. Keeps "Allocate" from the shipped hint (#4512). */
export const DRAFT_PAYMENT_HAS_EXCESS_COPY =
  "A draft payment can't be more than the invoices it pays. Allocate the full amount, or save it as paid.";

/** ADVANCE_NOT_AVAILABLE: an advance from an unconfirmed payment cannot be applied. */
export const ADVANCE_NOT_AVAILABLE_COPY =
  "This advance comes from a payment that isn't confirmed yet, so it can't be applied. Once that payment is confirmed, you can apply it.";

/** The fixed sentence for a payment refusal in `err`'s response body (`code`, and `reason` for INVOICE_NOT_PAYABLE), or null. */
export function paymentRefusalCopy(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  if (!data || typeof data !== "object") return null;
  const { code, reason } = data as { code?: unknown; reason?: unknown };
  if (code === API_ERROR_CODES.INVOICE_NOT_PAYABLE) {
    return typeof reason === "string" &&
      Object.prototype.hasOwnProperty.call(INVOICE_NOT_PAYABLE_COPY, reason)
      ? INVOICE_NOT_PAYABLE_COPY[reason]
      : INVOICE_NOT_PAYABLE_DEFAULT_COPY;
  }
  if (code === API_ERROR_CODES.DRAFT_PAYMENT_HAS_EXCESS) return DRAFT_PAYMENT_HAS_EXCESS_COPY;
  if (code === API_ERROR_CODES.ADVANCE_NOT_AVAILABLE) return ADVANCE_NOT_AVAILABLE_COPY;
  return null;
}
