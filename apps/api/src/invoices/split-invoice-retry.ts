import { ServiceUnavailableException } from "@nestjs/common";

/**
 * #2662 — a split-invoice creation that did not complete is a clean, retryable refusal, never a raw
 * 500. Under lock contention the office path's transaction can outlive Prisma's interactive-tx timeout;
 * Prisma rolls it back, so nothing was saved. It surfaces two ways in createSplitInvoices
 * (invoices.service.ts), both mapped here:
 *   - the in-tx create comes back null (what real Postgres shows — master used to throw a TypeError on
 *     `inv.items` here): the loop stops right there, before anything reads or flags it. Any per-line
 *     flag a caller sets on the created invoice belongs AFTER that check;
 *   - the transaction itself rejects with P2028.
 */
export const SPLIT_INVOICE_RETRY =
  "Invoice creation did not complete under load — nothing was saved. Please retry.";

export function splitInvoiceRetry(): ServiceUnavailableException {
  return new ServiceUnavailableException(SPLIT_INVOICE_RETRY);
}

/** Prisma's interactive-transaction timeout / closed-transaction error. */
export function isTxTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2028";
}
