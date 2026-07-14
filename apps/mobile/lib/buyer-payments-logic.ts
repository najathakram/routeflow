/**
 * Pure display helpers for the buyer Payments screen (P5-16c). Money figures
 * are SERVER values rendered verbatim — nothing here computes an amount; the
 * only logic is filtering + label formatting. RN-free.
 */
import type { BuyerStatementTransaction } from "./api/buyer";

/** "YYYY-MM" → "July 2026", UTC-safe. Malformed → as-is (never "Invalid Date"). */
export function monthLabel(bucket: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(bucket);
  if (!m) return bucket;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return bucket;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "CREDIT_CARD" → "Credit Card"; missing method → "Payment". */
export function formatPaymentMethod(method?: string | null): string {
  if (!method) return "Payment";
  return method
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Open CREDIT_NOTE rows (server remaining > 0) — a filter over server values,
 *  NOT a wallet recompute (the tile shows statement.availableCredit). */
export function activeCreditRows(
  transactions: BuyerStatementTransaction[] | undefined,
): BuyerStatementTransaction[] {
  return (transactions ?? []).filter((t) => t.type === "CREDIT_NOTE" && t.runningBalance > 0.001);
}

/** Render flags for one payment row. */
export function paymentRowFlags(p: {
  status?: string;
  checkStatus?: string | null;
  nsfFeeAmount?: number | string | null;
}): { voided: boolean; showNsfFee: boolean } {
  return {
    voided: p.status === "VOID",
    showNsfFee: p.checkStatus === "BOUNCED" && p.nsfFeeAmount != null,
  };
}
