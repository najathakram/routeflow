import { round4, roundMoney } from "./pricing";

/**
 * #2717 (SA-572 A1, SA-574 H4): the stored 4-dp unit price of one component piece of a
 * mixed pack — round4(net line subtotal / line pieces). `netLineSubtotal` is the NET stored
 * subtotal (after free units), never a list-price basis.
 *
 * Returns null when there is no meaningful price: a negative or non-finite subtotal, or
 * pieces that are not a finite number > 0. The sub-line then prints no price. A subtotal of 0
 * is a real price of 0.
 *
 * Display-only: never summed, taxed or credited (I5). Use `displayComponentUnitPrice` to print.
 */
export function componentUnitPrice4(netLineSubtotal: number, linePieces: number): number | null {
  if (!Number.isFinite(netLineSubtotal) || netLineSubtotal < 0) return null;
  if (!Number.isFinite(linePieces) || !(linePieces > 0)) return null;
  return round4(netLineSubtotal / linePieces);
}

/**
 * The 2-dp view of the STORED 4-dp price (SA-574 H5): roundMoney(stored). The double rounding
 * is intended — 24.99 over 200 stores 0.125 and shows 0.13, while roundMoney(24.99 / 200) is
 * 0.12. Never re-derive the display from the subtotal.
 */
export function displayComponentUnitPrice(storedUnitPrice4: number): number {
  return roundMoney(storedUnitPrice4);
}
