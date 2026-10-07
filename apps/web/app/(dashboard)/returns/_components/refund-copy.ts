// POS-4b: fixed copy + error classification for the refund-vs-credit choice. Never render
// server text for these errors (apps/web/lib/raw-message-allowlist.json must not grow).
import type { InlineReturnRefundTender } from "@routeflow/types";

export type RefundErrorKind = "changed" | "resolved" | "forbidden" | "failed";

export const REFUND_COPY = {
  heading: "How do you want to give the money back?",
  walkIn: "Walk-in sales can't hold store credit, so you'll give the money back.",
  failed: "Return saved. Refund didn't go through. Try again.",
  changed: "The refund amount changed. Check it and confirm again.",
  resolved: "This return is already done. Nothing more was refunded.",
  forbidden: "You don't have permission to refund this return.",
} as const;

export function refundErrorKind(err: unknown): RefundErrorKind {
  const res = (err as { response?: { status?: number; data?: { code?: string } } } | undefined)
    ?.response;
  if (res?.status === 403) return "forbidden";
  if (res?.status === 409 && res.data?.code === "REFUND_AMOUNT_CHANGED") return "changed";
  if (res?.status === 409 && res.data?.code === "RETURN_ALREADY_RESOLVED") return "resolved";
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
