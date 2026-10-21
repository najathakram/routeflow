import { roundMoney } from "./pricing";

/**
 * B1262 / SA-838 (review I1): whose return is it. ONE predicate, used by the tender provenance (which credit notes are the
 * sale's own return credit) and by the Returned line (how much of the sale was returned), so the two can never disagree.
 *
 * - A STANDARD return belongs to the order it is filed on (`Return.orderId`).
 * - An INLINE return is filed on a CARRYING order (usually another one) and sold per line: it belongs to an order only through
 *   an item whose `sourceOrderId` is that order. One carried on this order but sold on another is the OTHER order's.
 *
 * The caller passes LIVE returns only (a rejected or cancelled return proves nothing; that status list lives with the API).
 */
export interface OwnReturnItem {
  sourceOrderId?: string | null;
  /** the item's priced amount, INLINE items only (null on every STANDARD row) */
  subtotal?: unknown;
  taxAmount?: unknown;
  categoryTax?: unknown;
}

export interface OwnReturnShape {
  /** STANDARD (absent reads STANDARD) or INLINE */
  kind?: string;
  /** the order the return is filed on (for an INLINE return, the CARRYING order) */
  orderId: string;
  /** a STANDARD return's worth (the caller's one `returnAmount` rule); an INLINE return is worth its items' amounts instead */
  amount?: unknown;
  items?: ReadonlyArray<OwnReturnItem>;
}

export function isOwnReturn(orderId: string, r: OwnReturnShape): boolean {
  return r.kind === "INLINE"
    ? (r.items ?? []).some((i) => i.sourceOrderId === orderId)
    : r.orderId === orderId;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** The money of the order's own returns, in cents: STANDARD by its amount, INLINE by the priced items sold on this order. */
export function ownReturnedAmount(orderId: string, returns: ReadonlyArray<OwnReturnShape>): number {
  let total = 0;
  for (const r of returns) {
    if (!isOwnReturn(orderId, r)) continue;
    if (r.kind === "INLINE") {
      for (const i of r.items ?? []) {
        if (i.sourceOrderId !== orderId) continue;
        total += roundMoney(num(i.subtotal) + num(i.taxAmount) + num(i.categoryTax));
      }
    } else {
      total += num(r.amount);
    }
  }
  return roundMoney(total);
}
