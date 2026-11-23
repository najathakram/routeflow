import type { BuyerCreditItem } from "@routeflow/types";

/**
 * SA-1214 (D7'): the buyer's view of the operator statement. The portal tile reads `availableCredit`, so on the
 * buyer route it is the TOTAL (notes + advances); `advanceBalance` stays the advance PART of that total and no buyer
 * screen reads it. The staff route keeps `availableCredit` = notes and `advanceBalance` = advances untouched.
 * The credit list comes from the same read as the total, so its rows always sum to the tile (until truncated).
 */
export function toBuyerStatement<
  T extends {
    availableCredit: number;
    creditTotal: number;
    creditItems: BuyerCreditItem[];
    creditItemsTruncated: boolean;
  },
>(op: T) {
  const { creditTotal, creditItems, creditItemsTruncated, ...rest } = op;
  return { ...rest, availableCredit: creditTotal, creditItems, creditItemsTruncated };
}
