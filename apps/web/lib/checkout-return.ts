/**
 * SA-1139: what Stripe's return to /settings/billing means. The hosted flow and the embedded form both come back
 * as `?checkout=success` (or `?checkout=cancelled`); the older payment-due return is `?paid=1`. Every reader goes
 * through here so the three spellings are never copied.
 */
type ParamReader = { get(name: string): string | null } | null | undefined;

/** A payment was started and is being confirmed: `?paid=1` or `?checkout=success`. */
export function isStripeReturn(search: ParamReader | string): boolean {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  return p?.get("paid") === "1" || p?.get("checkout") === "success";
}

/** The person left the card form without paying. */
export function isCheckoutCancelled(params: ParamReader): boolean {
  return params?.get("checkout") === "cancelled";
}
