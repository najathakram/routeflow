import { ServiceUnavailableException } from "@nestjs/common";

/**
 * #2662 — a split-invoice creation that did not complete is a clean, retryable refusal, never a raw
 * 500. Two cases in createSplitInvoices (invoices.service.ts):
 *   - the office path's transaction outlived Prisma's interactive-tx timeout under lock contention
 *     (P2028): Prisma has rolled it back, so nothing was saved;
 *   - a create yielded no invoice: the loop stops right there, before anything reads or flags it.
 *     Any per-line flag a caller sets on the created invoice belongs AFTER that check.
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
