import { roundMoney } from "./pricing";

/**
 * One tender leg of a sale as the request states it. `amount` omitted = "the rest of the balance" (the
 * counter's rule: an unstated amount is the exact balance). Today the counter request carries ONE leg;
 * split tender feeds several.
 */
export interface ClearedTenderLeg {
  method: "CASH" | "CARD" | "CHECK" | "ON_ACCOUNT";
  amount?: number | null;
  /**
   * A CHECK that has not matured (post-dated): it is not money yet, so it counts 0. A CHECK without this flag
   * (no date, or dated today or earlier) is cleared like cash. The caller decides what "pending" means.
   */
  pending?: boolean;
}

/**
 * How much of `total` is PAID NOW, at the till, by the legs of this request: the ONE helper the credit
 * gate uses to count only what stays owed (`total - clearedTenderNow`). Money in the drawer or on the
 * card terminal (CASH, CARD) and a same-day CHECK clear at once; a leg flagged `pending` (a post-dated
 * check) and ON_ACCOUNT, which takes no money, count 0. Summed in whole cents (roundMoney), capped at the total (cash with change
 * never over-pays, so the remainder is never negative); a non-finite, zero or negative amount counts 0.
 */
export function clearedTenderNow(legs: ReadonlyArray<ClearedTenderLeg>, total: number): number {
  const totalCents = Math.max(0, Math.round(roundMoney(total) * 100));
  let paid = 0;
  for (const leg of legs) {
    if (leg.method === "ON_ACCOUNT" || leg.pending) continue;
    const stated = leg.amount;
    if (stated != null && (!Number.isFinite(stated) || stated <= 0)) continue;
    const cents = stated == null ? totalCents - paid : Math.round(roundMoney(stated) * 100);
    paid = Math.min(totalCents, paid + Math.max(0, cents));
  }
  return roundMoney(paid / 100);
}
