import type { BuyerProduct } from "@routeflow/types";

/**
 * OOS PR2 (R3c): what the buyer portal does with an out-of-stock item. The SERVER decides
 * (`canBackorder`, resolved once per request from the seller's out-of-stock-ordering setting for THIS
 * customer); the client only reads it, and an absent value means "cannot" (fail closed, as before).
 *
 * Where the seller hides backorders the server already reports such an item as in stock, so none of
 * this fires: the tile shows a normal "Add" and nothing about backorders reaches the buyer.
 */
export const SHIPS_WHEN_RESTOCKED = "Ships when restocked";

type StockInput = Pick<BuyerProduct, "stockStatus" | "canBackorder">;

const isOutOfStock = (p: StockInput): boolean => (p.stockStatus ?? "IN_STOCK") === "OUT_OF_STOCK";

/** Out of stock AND this buyer may order it anyway: "Add" + "Ships when restocked", not "Notify me". */
export const canOrderOutOfStock = (p: StockInput): boolean =>
  isOutOfStock(p) && p.canBackorder === true;

/** Out of stock and NOT orderable by this buyer: "Notify me", never addable (shop, favorites, reorder). */
export const isOrderBlocked = (p: StockInput): boolean =>
  isOutOfStock(p) && p.canBackorder !== true;

/** The tile / detail stock line. */
export function stockLine(p: Pick<BuyerProduct, "stockStatus" | "stockLeft" | "canBackorder">): {
  label: string;
  cls: string;
} {
  const status = p.stockStatus ?? "IN_STOCK";
  if (status === "OUT_OF_STOCK") {
    return canOrderOutOfStock(p)
      ? { label: SHIPS_WHEN_RESTOCKED, cls: "text-warning" }
      : { label: "Out of stock", cls: "text-danger" };
  }
  if (status === "LOW") {
    return {
      label: p.stockLeft != null ? `Only ${p.stockLeft} left` : "Low stock",
      cls: "text-warning",
    };
  }
  return { label: "In stock", cls: "text-success" };
}

/**
 * OOS PR2 (R4): what the cart says when the server refuses an order for stock (a coded
 * INSUFFICIENT_STOCK). Fixed copy, the portal's own: never a raw server string, never a number.
 */
export const BUYER_INSUFFICIENT_STOCK_COPY =
  "Some items aren't available in the amount you asked for. Lower the quantity or remove them, then try again.";
