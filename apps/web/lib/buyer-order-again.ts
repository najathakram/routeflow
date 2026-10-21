import { normalizeCartLine } from "./buyer-cart-line";
import type { CartItem } from "./buyer-cart";

interface OrderAgainLine {
  status?: string | null;
  productId?: string | null;
  qty: number | string;
  product?: { name: string; unit: string; unitsPerBox?: number | null } | null;
}

/** Order statuses that count as a past order the buyer can order again. */
export const ORDER_AGAIN_STATUSES = ["DELIVERED", "PARTIALLY_DELIVERED", "CANCELLED"];

/**
 * F32: the cart lines for "Order again". Catalog lines only: a cancelled line and a seller-added
 * custom line (no product) are not re-ordered. Quantity is the ordered piece count; the box split
 * is derived by `normalizeCartLine`, the one place that computes it. Prices are never carried:
 * the cart resolves them fresh from the catalog.
 */
export function orderAgainCartLines(lines: OrderAgainLine[]): CartItem[] {
  const out: CartItem[] = [];
  for (const li of lines) {
    if (li.status === "CANCELLED" || !li.productId || !li.product) continue;
    const qty = Math.trunc(Number(li.qty));
    if (!(qty > 0)) continue;
    out.push(
      normalizeCartLine({
        productId: li.productId,
        name: li.product.name,
        unit: li.product.unit,
        unitsPerBox: li.product.unitsPerBox ?? null,
        qty,
      }),
    );
  }
  return out;
}
