import { invoiceLineQtyText, normalizeBoxesPieces } from "@routeflow/pricing";
import type { OrderSuggestionProduct, RecentOrderLine, RecentOrderSummary } from "@routeflow/types";
import { displayProductName } from "@/lib/product-display";
import type { UnitOption } from "@/lib/unit-options";

/**
 * Pure logic behind "Usually buys" + "Order again" in the staff New Order modal. A plan carries a
 * product, a quantity and a unit and NEVER a price: the modal adds each line through its normal
 * add-line path, so every price is today's tier / special price, not what an old order paid.
 */

/** The fixed copy of the suggestions bar. */
export const ORDER_AGAIN_COPY = {
  usuallyBuys: "Usually buys",
  orderAgain: "Order again",
  chooseOrder: "Choose a recent order",
  confirmLines: "This order already has lines. Add these lines as well?",
  confirmAdd: "Add lines",
  confirmCancel: "Cancel",
} as const;

/** "3 items are no longer available" — inactive / retired (or deleted) products are skipped. */
export function unavailableMessage(n: number): string {
  return n === 1 ? "1 item is no longer available" : `${n} items are no longer available`;
}

export interface OrderedQty {
  qty: number;
  boxes?: number;
  pieces?: number;
}

/**
 * The qty fields of a re-added line, as ordered and normalised through `@routeflow/pricing`.
 *  - a unit line ("Carton") is a plain COUNT of that unit (boxes, or qty / factor);
 *  - a boxed product keeps its boxes + loose pieces at the product's CURRENT pack size, and a bare
 *    qty means BOXES;
 *  - anything else is a plain qty.
 * Null when the line has nothing to order.
 */
export function orderedQtyFields(
  line: RecentOrderLine,
  product: Pick<OrderSuggestionProduct, "unitsPerBox">,
): OrderedQty | null {
  const lineUpb = line.unitsPerBox && line.unitsPerBox > 1 ? line.unitsPerBox : null;
  if (line.unitLabel) {
    const count = lineUpb ? (line.boxes ?? Math.round(line.qty / lineUpb)) : line.qty;
    return count > 0 ? { qty: Math.trunc(count) } : null;
  }
  const upb = product.unitsPerBox ? Number(product.unitsPerBox) : 0;
  if (upb > 0) {
    const split = line.boxes != null || line.pieces != null;
    const boxes = split ? (line.boxes ?? 0) : line.qty;
    const pieces = split ? (line.pieces ?? 0) : 0;
    if (upb === 1) {
      // A pack of one: web still treats it as boxed (qty = boxes), and nothing can be "loose".
      const total = Math.max(0, Math.trunc(boxes) + Math.trunc(pieces));
      return total > 0 ? { qty: total, boxes: total, pieces: 0 } : null;
    }
    const n = normalizeBoxesPieces({ boxes, pieces, unitsPerBox: upb });
    return n.qty > 0 ? { qty: n.qty, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0 } : null;
  }
  // Not boxed now. A line that WAS boxed ordered its boxes; otherwise its qty is the count.
  const count = Math.trunc(lineUpb && line.boxes != null ? line.boxes : line.qty);
  return count > 0 ? { qty: count } : null;
}

/** What the add-line path is asked to add instead of its default "one": a quantity as ordered, in a unit. */
export interface OrderedAdd {
  qty: OrderedQty;
  /** The non-pack unit option the quantity is a count of; omitted = the product's pack. */
  unit?: UnitOption;
}

/**
 * An ordered quantity added onto a line that is already on the order (the same product and unit):
 * a unit line adds its count, a boxed line adds pieces (rolled into boxes), a plain line adds qty.
 */
export function mergeOrderedIntoLine<
  T extends {
    qty: number;
    unitLabel?: string;
    unitsPerBox?: number;
    boxes?: number;
    pieces?: number;
  },
>(line: T, ordered: OrderedQty): T {
  if (!line.unitLabel && line.unitsPerBox && line.unitsPerBox > 1) {
    const total = (line.boxes ?? 0) * line.unitsPerBox + (line.pieces ?? 0) + ordered.qty;
    const n = normalizeBoxesPieces({ qty: total, unitsPerBox: line.unitsPerBox });
    return { ...line, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
  }
  if (!line.unitLabel && line.unitsPerBox) {
    // A pack of one: qty and boxes move together.
    const boxes = (line.boxes ?? 0) + ordered.qty;
    return { ...line, boxes, pieces: 0, qty: boxes };
  }
  return { ...line, qty: line.qty + ordered.qty };
}

export interface OrderAgainItem {
  product: OrderSuggestionProduct;
  qty: OrderedQty;
  /** The non-pack unit the line sold by; undefined = the product's pack. */
  unitLabel: string | undefined;
}

export interface OrderAgainPlan {
  items: OrderAgainItem[];
  /** Lines skipped because the product is inactive, retired or gone. */
  unavailable: number;
}

export function planOrderAgain(
  order: RecentOrderSummary,
  products: Record<string, OrderSuggestionProduct>,
): OrderAgainPlan {
  const items: OrderAgainItem[] = [];
  let unavailable = 0;
  for (const line of order.lines) {
    const product = products[line.productId];
    if (!product || !product.isActive) {
      unavailable += 1;
      continue;
    }
    const qty = orderedQtyFields(line, product);
    if (!qty) continue;
    items.push({ product, qty, unitLabel: line.unitLabel ?? undefined });
  }
  return { items, unavailable };
}

/** "Chips × 2 boxes + 6 pcs, Soda × 4 Carton" — what the order contained, for the menu. */
export function orderAgainSummary(
  order: RecentOrderSummary,
  products: Record<string, OrderSuggestionProduct>,
): string {
  return order.lines
    .map((l) => {
      const p = products[l.productId];
      const name = p ? displayProductName(p) : "Item";
      const qty = invoiceLineQtyText({
        qty: l.qty,
        boxes: l.boxes,
        pieces: l.pieces,
        unitLabel: l.unitLabel,
      });
      return `${name} × ${qty}`;
    })
    .join(", ");
}
