/**
 * Build the replacement draft row when an operator substitutes a different
 * product onto an order line (order editor). Pure so the money rules below are
 * spec-pinned at the PRODUCER, not just at the payload builder.
 *
 * Two silent overcharges live here:
 *
 * 1. **Box split (B2).** The ordered PIECE count carries across the swap and is
 *    re-denominated against the SUBSTITUTE's own box size. The server prices a
 *    substitution from `boxes`/`pieces` × the substitute's `unitsPerBox`, so a
 *    row that inherits a bare piece qty with no split bills BOX price × piece
 *    count — 24 pieces onto a 12-pack billed 24 × the case price instead of 2 ×.
 * 2. **Base price (B3).** `catalogPrice` (the diff's `basePrice`) holds the
 *    substitute's LIST price — the price the server falls back to when the
 *    payload carries no `unitPrice` — while `unitPrice` holds the customer's
 *    tier price. Storing the tier price in BOTH made every tier-priced
 *    substitution look un-overridden, so the price on the card never reached
 *    the server and the line billed LIST. This also matches how an existing
 *    line loads into this editor (catalogPrice = the product's list price).
 */
import { effectiveQty, normalizeBoxesPieces } from "@routeflow/pricing";

/** The draft row being replaced (order-editor `DraftItem` shape, structurally). */
export interface SubstitutedFromLine {
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** Original DB line id; undefined = the row was added this session. */
  lineId?: string;
}

export interface SubstituteProduct {
  id: string;
  name: string;
  unit?: string;
  unitsPerBox?: number | null;
}

export interface SubstitutedLine {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox: number | null;
  unitPrice: number;
  catalogPrice: number;
  name: string;
  unit?: string;
  lineId?: string;
  substituteProductId?: string;
  boxSplit: boolean;
}

/**
 * The row's quantity in PIECES. A split line already stores pieces; a boxed row
 * with NO split is a box-UNAWARE line whose `qty` is a SELLING-UNIT (box) count
 * — the same expansion the server applies (`qtyPieces` in orders.service.ts).
 * Reading that qty as pieces would UNDER-charge the substitution by unitsPerBox.
 */
function inheritedPieces(previous: SubstitutedFromLine): number {
  if (previous.boxes != null || previous.pieces != null) {
    return effectiveQty(previous, previous.unitsPerBox);
  }
  const upb = Number(previous.unitsPerBox ?? 0);
  const qty = previous.qty ?? 0;
  return upb > 1 ? qty * upb : qty;
}

export function buildSubstituteLine(args: {
  /** The row being replaced (undefined only if it vanished from the draft). */
  previous?: SubstitutedFromLine;
  product: SubstituteProduct;
  /** The customer's tier price for the substitute — what the card shows. */
  tierPrice: number;
  /** The substitute's LIST price — what the server bills with no `unitPrice`. */
  listPrice: number;
}): SubstitutedLine {
  const { previous, product, tierPrice, listPrice } = args;
  const unitsPerBox = product.unitsPerBox == null ? null : Number(product.unitsPerBox);
  // A substitution always carries at least one unit across.
  const inheritedQty = Math.max(1, previous ? inheritedPieces(previous) : 1);
  const split = normalizeBoxesPieces({ qty: inheritedQty, unitsPerBox });
  return {
    productId: product.id,
    qty: split.qty,
    // Only a boxed substitute carries a split; swapping onto a loose product
    // leaves boxes/pieces absent so the payload stays a plain piece qty.
    ...(split.boxes != null ? { boxes: split.boxes, pieces: split.pieces ?? 0 } : {}),
    unitsPerBox,
    unitPrice: tierPrice,
    catalogPrice: listPrice,
    name: product.name,
    unit: product.unit,
    // Preserve the original line id so the diff emits a substitution (swap
    // product on the same line) rather than delete + create.
    lineId: previous?.lineId,
    substituteProductId: previous?.lineId ? product.id : undefined,
    boxSplit: split.boxes != null,
  };
}
