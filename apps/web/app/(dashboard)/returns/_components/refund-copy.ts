// POS-4b: fixed copy + error classification for the refund-vs-credit choice. Never render
// server text for these errors (apps/web/lib/raw-message-allowlist.json must not grow).
import { API_ERROR_CODES, type InlineRefundTender } from "@routeflow/types";

export type RefundErrorKind =
  | "changed"
  | "resolved"
  | "resolvedAfterRetry"
  | "forbidden"
  | "needsPaid"
  | "refundedCash"
  | "notRefundable"
  | "paidWithCredit"
  | "exceedsCash"
  | "failed";

/** Every kind except "failed" (retry) and "changed" (re-quote, fresh confirm) ends the refund: Close only. */
export const TERMINAL_REFUND_ERRORS: ReadonlySet<RefundErrorKind> = new Set([
  "resolved",
  "resolvedAfterRetry",
  "forbidden",
  "needsPaid",
  "refundedCash",
  "notRefundable",
  "paidWithCredit",
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
  /** F4: a sale paid (partly) with store credit goes back as store credit. */
  paidWithCredit: "Paid with store credit, so it goes back as store credit",
  /** SA-749r2 #9: the cash refund is more than the cash taken for the sale (less cash already refunded). Not terminal: switch the tender. */
  exceedsCash:
    "Return saved. That's more cash than was taken for this sale. Refund the rest by card or check, or give store credit.",
  /** SA-727b: a saved REFUND-intent return with no refund yet (shown on the receipt; no amount paid). */
  pendingReceipt: "Return — refund pending, nothing paid out",
} as const;

export function refundErrorKind(err: unknown): RefundErrorKind {
  const res = (err as { response?: { status?: number; data?: { code?: string } } } | undefined)
    ?.response;
  if (res?.status === 403) return "forbidden";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.REFUND_AMOUNT_CHANGED)
    return "changed";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.RETURN_ALREADY_RESOLVED)
    return "resolved";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.REFUND_NEEDS_PAID_INVOICE)
    return "needsPaid";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.RETURN_REFUNDED_CASH)
    return "refundedCash";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.RETURN_NOT_REFUNDABLE)
    return "notRefundable";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.REFUND_PAID_WITH_STORE_CREDIT)
    return "paidWithCredit";
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.REFUND_EXCEEDS_CASH_PAID)
    return "exceedsCash";
  return "failed";
}

/** SA-727: the quote's `paidMethods` are PaymentMethod values (sorted); the first one a refund can use preselects the
 *  "Refund by" tender (CREDIT_CARD -> CARD). Anything else (ACH, OTHER, none) falls back to Cash. */
export function tenderFromPaidMethods(methods: readonly string[] | undefined): InlineRefundTender {
  for (const m of methods ?? []) {
    if (m === "CASH") return "CASH";
    if (m === "CREDIT_CARD" || m === "CARD") return "CARD";
    if (m === "CHECK") return "CHECK";
  }
  return "CASH";
}

/** The hand-back sentence: card refunds go back on the card, cash/check are handed over. */
export function handBackLine(tender: InlineRefundTender, amount: string): string {
  return tender === "CARD"
    ? `Give ${amount} back on the customer's card at the terminal.`
    : `Hand ${amount} back to the customer.`;
}

export const TENDER_OPTIONS: { value: InlineRefundTender; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "CHECK", label: "Check" },
];
