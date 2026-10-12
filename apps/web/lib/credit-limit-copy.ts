const usd = (n: unknown): string | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? `$${n.toFixed(2)}` : null;

/**
 * The fixed sentence for a CREDIT_LIMIT_EXCEEDED refusal (B986): built from the body's STRUCTURED `limit` / `exposure`
 * numbers, never the server's own text. Says what to do: collect a payment, or cancel the change (there is no override).
 */
export function creditLimitSentence(limit: unknown, exposure: unknown): string {
  const l = usd(limit);
  const e = usd(exposure);
  return l && e
    ? `This would put the customer's balance at ${e}, over their ${l} credit limit. Collect a payment to bring it under the limit, or cancel the change.`
    : "This would exceed the customer's credit limit. Collect a payment to bring them under it, or cancel the change.";
}

/**
 * The same refusal at the COUNTER: the sale was refused before anything was written, so the next step is to collect a
 * payment on the account or ring it to another customer (never "cancel the change", which is an order-edit idea).
 */
export function creditLimitCounterSentence(limit: unknown, exposure: unknown): string {
  const l = usd(limit);
  const e = usd(exposure);
  return l && e
    ? `This sale would put the customer's balance at ${e}, over their ${l} credit limit. Collect a payment on their account, or choose another customer, then try again.`
    : "This sale would exceed the customer's credit limit. Collect a payment on their account, or choose another customer, then try again.";
}
