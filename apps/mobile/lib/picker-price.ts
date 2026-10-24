import { toNumber } from "./cart-line-state";

/**
 * B1007 (money): the number a product-picker row shows. The order editor bills a picked / substituted line at the
 * CUSTOMER's tier price, so its picker passes that same pricing function (`priceFor`); without one (every other caller)
 * the row shows the product's list price, as it always did. Display only: nothing is priced here.
 */
export function pickRowPrice<P extends { pricePerUnit: number | string }>(
  p: P,
  priceFor?: (p: P) => number,
): number {
  return priceFor ? priceFor(p) : toNumber(p.pricePerUnit);
}
