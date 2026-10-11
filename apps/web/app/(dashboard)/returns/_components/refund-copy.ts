// POS-4b: fixed copy + error classification for the refund-vs-credit choice. Never render
// server text for these errors (apps/web/lib/raw-message-allowlist.json must not grow).
import { roundMoney } from "@routeflow/pricing";
import {
  API_ERROR_CODES,
  type InlineRefundTender,
  type InlineReturnQuoteResponse,
} from "@routeflow/types";

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
  | "dayClosed"
  | "failed";

/** Every kind except "failed" / "exceedsCash" (retry) and "changed" (re-quote, fresh confirm) ends the refund here. */
export const TERMINAL_REFUND_ERRORS: ReadonlySet<RefundErrorKind> = new Set([
  "resolved",
  "resolvedAfterRetry",
  "forbidden",
  "needsPaid",
  "refundedCash",
  "notRefundable",
  "paidWithCredit",
  // SA-750r3: the day's close is in force, so Retry would be refused again: store credit, or close and refund on a later date.
  "dayClosed",
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
  /** SA-750r3: the refund is dated inside a closed day (409 COUNTER_SALE_DAY_CLOSED). The return is saved; nothing was paid out. */
  dayClosed:
    "Return saved. This day is closed, so the refund can't be paid out now. Give store credit instead, or record the refund on a later date.",
  /** The same refusal for a walk-in, who can't hold store credit: only the later date is left. */
  dayClosedWalkIn:
    "Return saved. This day is closed, so the refund can't be paid out now. Record the refund on a later date.",
  /** W21b: the quote-step note when Refund is the chosen resolution (store credit keeps the credit-note line). */
  quoteRefundNote: "This will be refunded to the customer, not added to their balance.",
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
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED)
    return "dayClosed";
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

/** SA-749r2 item 9 (G7): shown on the refund choice when the refund is more than the sale's cash can go back as. */
export const cashBackCopy = (amount: string): string => `Up to ${amount} back in cash`;

/**
 * Whether a cash refund of this quote would pass the server's cap, from the quote alone (no client math on the wrong fields):
 * per source sale, the refund's share (its chunks' subtotal + tax + category tax) against that sale's `cashRefundable`. `exceeds`
 * is true when ANY sale's share is above its room (the 409 REFUND_EXCEEDS_CASH_PAID case); `upTo` is the most that can go back
 * in cash, the sum over the sales of the lesser of share and room (a sale with no figure counts whole). null when the quote carries no `cashRefundable` (an older
 * API) or no chunk sits on a sale: then nothing is limited here and the server's cap still answers.
 */
export function cashRefundLimit(
  quote: Pick<InlineReturnQuoteResponse, "chunks"> &
    Partial<Pick<InlineReturnQuoteResponse, "cashRefundable">>,
): { exceeds: boolean; upTo: number } | null {
  const rooms = quote.cashRefundable;
  if (!rooms) return null;
  const shares = new Map<string, number>();
  for (const c of quote.chunks) {
    if (!c.sourceOrderId) continue;
    shares.set(
      c.sourceOrderId,
      roundMoney((shares.get(c.sourceOrderId) ?? 0) + c.subtotal + c.taxAmount + c.categoryTax),
    );
  }
  if (shares.size === 0) return null;
  let exceeds = false;
  let upTo = 0;
  for (const [orderId, share] of shares) {
    const known = rooms[orderId];
    if (known === undefined) {
      upTo = roundMoney(upTo + share); // no figure for this sale (an older API): nothing limits it here
      continue;
    }
    const room = Math.max(0, known);
    if (share > room + 0.001) exceeds = true;
    upTo = roundMoney(upTo + Math.min(share, room));
  }
  return { exceeds, upTo };
}
