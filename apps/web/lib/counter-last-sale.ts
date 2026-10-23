import type { CounterSaleRequest } from "@routeflow/types";

/**
 * SA-837b item 3: the counter sale the till just rang, kept in memory (never persisted) so a payment refused as a duplicate
 * reference can be RE-SENT with "Record anyway": the same sale (same Idempotency-Key, same cart), now with the generic
 * `payment.recordAnyway` flag. `useCreateCounterSale` remembers it when the answer says the payment was not recorded; the
 * panel looks it up by the receipt's order id, so a stale sale is never re-sent for another receipt.
 */
let last: { orderId: string; key: string; dto: CounterSaleRequest } | null = null;

export function rememberCounterSale(orderId: string, key: string, dto: CounterSaleRequest): void {
  last = { orderId, key, dto };
}

export function counterSaleToResend(
  orderId: string,
): { orderId: string; key: string; dto: CounterSaleRequest } | null {
  return last && last.orderId === orderId ? last : null;
}

export function forgetCounterSale(): void {
  last = null;
}
