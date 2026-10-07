/**
 * Derivations for the split-view scan tray: the live "order so far" list shown
 * UNDER the camera while the operator scans, newest line first.
 *
 * Money never happens here — every subtotal comes from `computeLineSubtotal`
 * with the SAME raw line fields the builder footer passes, so the tray and the
 * footer cannot disagree by construction.
 */
import { computeLineSubtotal, effectiveQty, normalizeBoxesPieces } from "@routeflow/pricing";
import { displayProductName, type DisplayProductLike } from "./product-display";

/** Line state as the sale builders hold it (mirrors NewOrderScreen's LineState). */
export interface TrayLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  /** One-time per-selling-unit override; falls back to the resolved tier price. */
  unitPrice?: number;
  /** units_v1 (SA-085h HIGH): set when this line is sold by a unit (Case…) — its qty is a
   *  COUNT, never pieces-in-a-box, so the row is never re-split against the pack's size. */
  unitLabel?: string | null;
}

export interface TrayProduct extends DisplayProductLike {
  id: string;
  unitsPerBox?: number | null;
}

/** Ad-hoc, non-catalog line: free-text name, per-piece price, never boxed. */
export interface TrayUnlistedLine {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface TrayRow {
  id: string;
  name: string;
  /** Total pieces — what the row's stepper edits. */
  qty: number;
  /** Compact operator-facing quantity: "2 cs + 1" | "2 cs" | "3". */
  qtySummary: string;
  subtotal: number;
  /** Case pack size, null when the product is sold as single units. */
  unitsPerBox: number | null;
  unlisted: boolean;
}

/**
 * Move `id` to the front of the scan order without duplicating it, preserving
 * the relative order of the rest. Returns the SAME array reference when `id` is
 * already first so a re-render of an unchanged tray stays memo-stable.
 */
export function bumpScanOrder(order: string[], id: string): string[] {
  if (order[0] === id) return order;
  const rest = order.filter((existing) => existing !== id);
  return [id, ...rest];
}

/** Which row is flashing. `nonce` climbs so re-scanning the same item re-flashes. */
export interface ScanFlash {
  id: string;
  nonce: number;
}

export function nextFlash(prev: ScanFlash | null | undefined, id: string): ScanFlash {
  return { id, nonce: (prev?.nonce ?? 0) + 1 };
}

/**
 * "bx" (box) rather than the document-facing "boxes + pcs" of
 * `formatQtySplit`: the tray is operator-facing selling UI, where the Box/Piece
 * vocabulary applies, and it has to stay glanceable in a narrow row.
 */
function formatTrayQty(boxes: number | null, pieces: number | null, qty: number): string {
  if (boxes == null && pieces == null) return String(Math.max(0, Math.trunc(qty)));
  const b = Math.max(0, Math.trunc(boxes ?? 0));
  const p = Math.max(0, Math.trunc(pieces ?? 0));
  if (b === 0) return String(p);
  return p > 0 ? `${b} bx + ${p}` : `${b} bx`;
}

function catalogRow(
  id: string,
  line: TrayLine,
  product: TrayProduct,
  unitPrice: number,
  overridable: boolean,
  freeUnits: number,
): TrayRow | null {
  // units_v1 (SA-085h HIGH): a unit-sold line's qty is a COUNT, never pieces-in-a-box — the
  // pack's own unitsPerBox must never re-split it (a 2-Case line must read "2", not get folded
  // against a 24-pack) or price it as a pack-priced box (2 Cases at $220 must total $440, not
  // 2 x the pack's own tier price).
  const packUpb = line.unitLabel ? null : (product.unitsPerBox ?? null);
  const qty = effectiveQty(line, packUpb);
  if (qty <= 0) return null;
  const split = normalizeBoxesPieces({
    boxes: line.boxes,
    pieces: line.pieces,
    qty,
    unitsPerBox: packUpb,
  });
  return {
    id,
    name: displayProductName(product),
    qty,
    qtySummary: formatTrayQty(split.boxes, split.pieces, qty),
    subtotal: computeLineSubtotal({
      unitPrice: overridable && line.unitPrice != null ? line.unitPrice : unitPrice,
      qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: packUpb,
      freeUnits,
    }),
    unitsPerBox: packUpb,
    unlisted: false,
  };
}

export interface TrayRowsInput {
  items: Record<string, TrayLine>;
  unlisted?: readonly TrayUnlistedLine[];
  /** Newest-first product ids, as maintained by {@link bumpScanOrder}. */
  scanOrder: readonly string[];
  lookup: (id: string) => TrayProduct | undefined;
  /**
   * The customer's effective per-selling-unit price. Takes the LINE too (SA-085h HIGH) so a
   * caller can resolve a unit-sold line's own price (`lineUnitFor`/`unitPriceBase`) instead of
   * the pack's tier price — the same price every other reader of this line already uses.
   */
  priceFor: (product: TrayProduct, line: TrayLine) => number;
  /**
   * Whether a line-level unitPrice override counts for this product. SPECIAL
   * (tier≠1) lines return false so the tray charges the tier price, matching
   * the footer/submit which also ignore overrides there. Default: always true.
   */
  overridable?: (product: TrayProduct) => boolean;
  /**
   * Whole SELLING units a BUY_N_GET_M promo makes free for this line, passed
   * straight into `computeLineSubtotal`'s `freeUnits` so the row nets the same
   * saving the footer does. Default 0: every existing caller is unaffected.
   */
  freeUnitsFor?: (id: string, line: TrayLine) => number;
}

/**
 * Newest-first tray rows. Scanned lines lead in scan order; lines that already
 * existed when scan mode opened (absent from `scanOrder`) follow in insertion
 * order. Zero-qty lines and lines whose product hasn't loaded are skipped.
 */
export function trayRowsFrom({
  items,
  unlisted = [],
  scanOrder,
  lookup,
  priceFor,
  overridable,
  freeUnitsFor,
}: TrayRowsInput): TrayRow[] {
  const rank = new Map<string, number>();
  scanOrder.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });

  const scanned: TrayRow[] = [];
  const rest: TrayRow[] = [];
  const push = (row: TrayRow | null) => {
    if (row) (rank.has(row.id) ? scanned : rest).push(row);
  };

  for (const [id, line] of Object.entries(items)) {
    const product = lookup(id);
    if (!product) continue;
    push(
      catalogRow(
        id,
        line,
        product,
        priceFor(product, line),
        overridable?.(product) ?? true,
        freeUnitsFor?.(id, line) ?? 0,
      ),
    );
  }
  for (const u of unlisted) {
    if (u.qty <= 0) continue;
    push({
      id: u.id,
      name: u.name,
      qty: u.qty,
      qtySummary: formatTrayQty(null, null, u.qty),
      subtotal: computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty }),
      unitsPerBox: null,
      unlisted: true,
    });
  }

  scanned.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...scanned, ...rest];
}
