import { API_ERROR_CODES, type CounterSaleHandBack } from "@routeflow/types";
import { formatReceiptMoney } from "./counter-receipt";

/**
 * SA-762r Ruling B (web): every refusal of `POST /orders/counter-sale/:orderId/void` is shown as FIXED copy chosen by the
 * server's `body.code`. The server `message` is never read (owner rule: no raw server strings in the UI). The closed set is
 * the void's own codes plus the two kept cash-refund guards and the not-found; `Record<..>` makes a new code without copy a
 * compile error. generic-toast-copy.ts carries the four void-only codes too, so any other surface that toasts one reads
 * the same sentence. COUNTER_SALE_DAY_CLOSED is NOT void-only (a payment edit, a pickup tender and a refund get it too):
 * only here does it say "can't be voided. Use Return items instead"; every other surface keeps day-closed-copy.ts's sentence.
 */
export const COUNTER_VOID_ERROR_CODES = [
  API_ERROR_CODES.COUNTER_SALE_VOIDED,
  API_ERROR_CODES.COUNTER_SALE_VOID_HAS_RETURN,
  API_ERROR_CODES.COUNTER_SALE_VOID_FOREIGN_PAYMENT,
  API_ERROR_CODES.COUNTER_SALE_VOID_NOT_TODAY,
  API_ERROR_CODES.COUNTER_SALE_VOID_BUSY,
  API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
  API_ERROR_CODES.ORDER_HAS_CASH_REFUND,
  API_ERROR_CODES.INVOICE_HAS_CASH_REFUND,
  API_ERROR_CODES.COUNTER_SALE_NOT_FOUND,
] as const;
export type CounterVoidErrorCode = (typeof COUNTER_VOID_ERROR_CODES)[number];

export const COUNTER_VOID_ERROR_COPY: Record<CounterVoidErrorCode, string> = {
  [API_ERROR_CODES.COUNTER_SALE_VOIDED]: "This sale was already voided. Nothing more to do.",
  [API_ERROR_CODES.COUNTER_SALE_VOID_HAS_RETURN]:
    "A return was recorded for this sale. Reverse the return in the office before voiding it.",
  [API_ERROR_CODES.COUNTER_SALE_VOID_FOREIGN_PAYMENT]:
    "This sale holds a payment the register didn't take (store credit, an advance, an office payment or a deposited check). Ask the office to reverse it first.",
  [API_ERROR_CODES.COUNTER_SALE_VOID_NOT_TODAY]:
    "Only a sale rung today can be voided at the register. Ask the office to handle this one.",
  [API_ERROR_CODES.COUNTER_SALE_VOID_BUSY]:
    "This sale is being updated at the register right now. Try voiding it again in a moment.",
  // The sale (or a payment it reverses) is dated inside a day whose close is in force: a closed day's totals never move.
  [API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED]:
    "This sale is in a closed day and can't be voided. Use Return items instead.",
  [API_ERROR_CODES.ORDER_HAS_CASH_REFUND]:
    "Part of this sale was refunded in cash, so it can't be voided here. Ask the office to issue a credit note instead.",
  [API_ERROR_CODES.INVOICE_HAS_CASH_REFUND]:
    "Part of this sale was refunded in cash, so it can't be voided here. Ask the office to issue a credit note instead.",
  [API_ERROR_CODES.COUNTER_SALE_NOT_FOUND]:
    "This sale couldn't be found. Refresh Today's sales and try again.",
};

/** The reason the clerk types: 3-200 characters once control characters are stripped and the ends trimmed (the server's rule). */
export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 200;
export const VOID_REASON_REQUIRED_COPY = "Enter a reason of at least 3 characters.";

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** The reason as it is sent. */
export const cleanVoidReason = (raw: string): string => raw.replace(CONTROL_CHARS, "").trim();

/** null = the reason can be sent; otherwise the fixed line to show. */
export function voidReasonProblem(raw: string): string | null {
  const n = cleanVoidReason(raw).length;
  return n < VOID_REASON_MIN || n > VOID_REASON_MAX ? VOID_REASON_REQUIRED_COPY : null;
}

/**
 * The hand-back instruction, from the SERVER's amounts only (nothing is added up here):
 * "Give back $X cash · Void the $Y card payment on the card terminal". A method with nothing to hand back is absent.
 */
export function handBackLines(handBack: CounterSaleHandBack | null | undefined): string[] {
  const lines: string[] = [];
  const h = handBack ?? {};
  if (h.CASH != null && h.CASH > 0) lines.push(`Give back ${formatReceiptMoney(h.CASH)} cash`);
  if (h.CHECK != null && h.CHECK > 0)
    lines.push(`Return the ${formatReceiptMoney(h.CHECK)} check to the customer`);
  if (h.CARD != null && h.CARD > 0)
    lines.push(`Void the ${formatReceiptMoney(h.CARD)} card payment on the card terminal`);
  return lines;
}
