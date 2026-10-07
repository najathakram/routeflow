// POS-4b: fixed copy + error classification for the refund-vs-credit choice. Never render
// server text for these errors (apps/web/lib/raw-message-allowlist.json must not grow).
import type { InlineReturnRefundTender } from "@routeflow/types";

export type RefundErrorKind =
  | "changed"
  | "resolved"
  | "resolvedAfterRetry"
  | "forbidden"
  | "needsPaid"
  | "refundedCash"
  | "notRefundable"
  | "failed";

/** Every kind except "failed" (retry) and "changed" (re-quote, fresh confirm) ends the refund: Close only. */
export const TERMINAL_REFUND_ERRORS: ReadonlySet<RefundErrorKind> = new Set([
  "resolved",
  "resolvedAfterRetry",
  "forbidden",
  "needsPaid",
  "refundedCash",
  "notRefundable",
]);

export const REFUND_COPY = {
  heading: "How do you want to give the money back?",
  walkIn: "Walk-in sales can't hold store credit, so you'll give the money back.",
  failed: "Return saved. Refund didn't go through. Try again.",
  changed: "The refund amount changed. Check it and confirm again.",
  resolved: "This return is already done. Nothing more was refunded.",
  resolvedAfterRetry:
    "This refund is already recorded. Check the return before handing anything over.",
  forbidden: "You don't have permission to refund this return.",
  needsPaid:
    "Return saved. This sale isn't fully paid, so it can't be refunded. Issue store credit from the order instead.",
  refundedCash: "This return was already refunded. Nothing more was refunded.",
  notRefundable: "There's nothing to refund on this return.",
  /** SA-727b: a saved REFUND-intent return with no refund yet (shown on the receipt; no amount paid). */
  pendingReceipt: "Return — refund pending, nothing paid out",
} as const;

export function refundErrorKind(err: unknown): RefundErrorKind {
  const res = (err as { response?: { status?: number; data?: { code?: string } } } | undefined)
    ?.response;
  if (res?.status === 403) return "forbidden";
  if (res?.status === 409 && res.data?.code === "REFUND_AMOUNT_CHANGED") return "changed";
  if (res?.status === 409 && res.data?.code === "RETURN_ALREADY_RESOLVED") return "resolved";
  if (res?.status === 409 && res.data?.code === "REFUND_NEEDS_PAID_INVOICE") return "needsPaid";
  if (res?.status === 409 && res.data?.code === "RETURN_REFUNDED_CASH") return "refundedCash";
  if (res?.status === 409 && res.data?.code === "RETURN_NOT_REFUNDABLE") return "notRefundable";
  return "failed";
}

/** The hand-back sentence: card refunds go back on the card, cash/check are handed over. */
export function handBackLine(tender: InlineReturnRefundTender, amount: string): string {
  return tender === "CARD"
    ? `Give ${amount} back on the customer's card at the terminal.`
    : `Hand ${amount} back to the customer.`;
}

export const TENDER_OPTIONS: { value: InlineReturnRefundTender; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "CHECK", label: "Check" },
];
