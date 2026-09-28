import type { InvoiceStatus } from "./api/enums";

/**
 * Owner request (#2089): "once an order is delivered, automatically open that order's
 * invoice and ask whether to send it" — the ONE shared decision behind all three surfaces
 * that complete a delivery: the mobile driver (route stop completion), mobile operator
 * (order detail's "any path into DELIVERED"), and web (`handleDeliver`).
 *
 * `invoices.service.ts`'s `sendEmail` does NOT refuse a DRAFT invoice — it sends the email
 * and, on success, atomically flips DRAFT → SENT in the SAME transaction (the "send" call
 * itself issues it). So a DRAFT never needs a separate "finalize" step before sending; the
 * prompt just needs to say so, since "Send" alone would be misleading for a line item that
 * has never actually been issued to the customer before. VOID is the one status `sendEmail`
 * genuinely refuses ("Cannot send a voided invoice") — never worth a send prompt.
 */
export type PostDeliveryInvoicePromptOutcome =
  /** No invoice exists for this order at all — nothing to prompt. */
  | "skip"
  /** A DRAFT invoice — sending it will issue it (DRAFT → SENT) in the same action. */
  | "issue-and-send"
  /** An already-issued invoice (SENT/VIEWED/PARTIAL/PAID/OVERDUE/WRITTEN_OFF) — a plain send. */
  | "send"
  /** No network to check the invoice at all — try again once synced. */
  | "offline-later";

export interface PostDeliveryInvoicePromptInput {
  /** The order's invoice, or null/undefined when none exists yet. Only `status` is read. */
  invoice: { status: InvoiceStatus } | null | undefined;
  /** Whether the device can currently reach the API. */
  online: boolean;
}

/**
 * Offline is checked FIRST and unconditionally: without a network round-trip there is no
 * way to know whether an invoice exists at all, let alone its status, so "no invoice" and
 * "offline" are never conflated — a device that goes offline right after a delivery must
 * never read as "this order has no invoice."
 */
export function postDeliveryInvoicePrompt({
  invoice,
  online,
}: PostDeliveryInvoicePromptInput): PostDeliveryInvoicePromptOutcome {
  if (!online) return "offline-later";
  if (!invoice) return "skip";
  if (invoice.status === "VOID") return "skip";
  if (invoice.status === "DRAFT") return "issue-and-send";
  return "send";
}
