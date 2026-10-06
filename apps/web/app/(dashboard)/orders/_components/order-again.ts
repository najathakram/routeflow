import { invoiceLineQtyText, legacyLinePieces, normalizeBoxesPieces } from "@routeflow/pricing";
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
  unavailable: "Suggestions unavailable",
  addFailed: "Couldn't add those items. Try again.",
} as const;

/** "3 items are no longer available" — inactive / retired (or deleted) products are skipped. */
export function unavailableMessage(n: number): string {
  return n === 1 ? "1 item is no longer available" : `${n} items are no longer available`;
}

/** "3 items could not be added because their quantities are unclear" — a legacy line whose unit cannot be decided. */
export function unclearMessage(n: number): string {
  return n === 1
    ? "1 item could not be added because its quantity is unclear"
    : `${n} items could not be added because their quantities are unclear`;
}

/** The pack size of a product changed since the order: boxes were kept, so the piece count moved. */
export function repackMessage(n: number): string {
  return n === 1
    ? "1 item has a new pack size, so check its quantity"
    : `${n} items have a new pack size, so check their quantities`;
}

export interface OrderedQty {
  qty: number;
  boxes?: number;
  pieces?: number;
}

/** An ordered quantity that cannot be decided from the stored line: skip it, never guess. */
export const UNCLEAR_QTY = "unclear" as const;

/**
 * The qty fields of a re-added line, as ordered and normalised through `@routeflow/pricing`.
 *  - a unit line ("Carton") is a plain COUNT of that unit (boxes, or qty / factor);
 *  - a line that stored its box / piece split keeps its boxes + loose pieces at the product's
 *    CURRENT pack size (or, if the product is no longer boxed, its piece count);
 *  - a legacy line with NO stored split is classified by `legacyLinePieces` with the product's
 *    current pack as the gate: it is a plain count only when the product is not boxed today. On a
 *    boxed product it is UNCLEAR (24 loose items must never become 24 boxes = 288 pieces).
 * Null when the line has nothing to order.
 */
export function orderedQtyFields(
  line: RecentOrderLine,
  product: Pick<OrderSuggestionProduct, "unitsPerBox">,
): OrderedQty | null | typeof UNCLEAR_QTY {
  const lineUpb = line.unitsPerBox && line.unitsPerBox > 1 ? line.unitsPerBox : null;
  if (line.unitLabel) {
    const count = lineUpb ? (line.boxes ?? Math.round(line.qty / lineUpb)) : line.qty;
    return count > 0 ? { qty: Math.trunc(count) } : null;
  }
  const upb = product.unitsPerBox ? Number(product.unitsPerBox) : 0;
  const split = line.boxes != null || line.pieces != null;
  if (split && upb > 1) {
    const n = normalizeBoxesPieces({
      boxes: line.boxes ?? 0,
      pieces: line.pieces ?? 0,
      unitsPerBox: upb,
    });
    return n.qty > 0 ? { qty: n.qty, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0 } : null;
  }
  // No usable split for a boxed pack: the line's qty is pieces when it stored a split (a repack to
  // "each" keeps the goods), and is decided by the shared classifier when it stored none.
  const legacy = legacyLinePieces({ qty: line.qty, boxes: line.boxes, pieces: line.pieces }, null, {
    productPackNow: product.unitsPerBox == null ? null : Number(product.unitsPerBox),
  });
  if ("unknown" in legacy) return UNCLEAR_QTY;
  const count = Math.trunc(legacy.pieces);
  if (count <= 0) return null;
  // A pack of one: web still treats it as boxed (qty = boxes), and nothing can be "loose".
  return upb === 1 ? { qty: count, boxes: count, pieces: 0 } : { qty: count };
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
  /** Lines skipped because their quantity cannot be decided (a legacy line on a boxed product). */
  unclear: number;
  /** Lines added whose product has a different pack size now than when they were ordered. */
  repacked: number;
}

export function planOrderAgain(
  order: RecentOrderSummary,
  products: Record<string, OrderSuggestionProduct>,
): OrderAgainPlan {
  const items: OrderAgainItem[] = [];
  let unavailable = 0;
  let unclear = 0;
  let repacked = 0;
  for (const line of order.lines) {
    const product = products[line.productId];
    if (!product || !product.isActive) {
      unavailable += 1;
      continue;
    }
    const qty = orderedQtyFields(line, product);
    if (qty === UNCLEAR_QTY) {
      unclear += 1;
      continue;
    }
    if (!qty) continue;
    if (
      !line.unitLabel &&
      line.unitsPerBox &&
      line.unitsPerBox > 1 &&
      line.unitsPerBox !== (product.unitsPerBox ?? 0)
    ) {
      repacked += 1;
    }
    items.push({ product, qty, unitLabel: line.unitLabel ?? undefined });
  }
  return { items, unavailable, unclear, repacked };
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
