/**
 * Derivations for the split-view scan tray: the live "order so far" list shown
 * UNDER the camera while the operator scans, newest line first.
 *
 * Money never happens here — every subtotal comes from `computeLineSubtotal`
 * with the SAME raw line fields the builder footer passes, so the tray and the
 * footer cannot disagree by construction.
 */
import { computeLineSubtotal, effectiveQty, normalizeBoxesPieces } from "./pricing";
import { displayProductName, type DisplayProductLike } from "./product-display";

/** Line state as the sale builders hold it (mirrors NewOrderScreen's LineState). */
export interface TrayLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  /** One-time per-selling-unit override; falls back to the resolved tier price. */
  unitPrice?: number;
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
 * "cs" (case) rather than the document-facing "boxes + pcs" of
 * `formatQtySplit`: the tray is operator-facing selling UI, where the Case/Unit
 * vocabulary applies, and it has to stay glanceable in a narrow row.
 */
function formatTrayQty(boxes: number | null, pieces: number | null, qty: number): string {
  if (boxes == null && pieces == null) return String(Math.max(0, Math.trunc(qty)));
  const b = Math.max(0, Math.trunc(boxes ?? 0));
  const p = Math.max(0, Math.trunc(pieces ?? 0));
  if (b === 0) return String(p);
  return p > 0 ? `${b} cs + ${p}` : `${b} cs`;
}

function catalogRow(
  id: string,
  line: TrayLine,
  product: TrayProduct,
  unitPrice: number,
): TrayRow | null {
  const qty = effectiveQty(line, product.unitsPerBox);
  if (qty <= 0) return null;
  const split = normalizeBoxesPieces({
    boxes: line.boxes,
    pieces: line.pieces,
    qty,
    unitsPerBox: product.unitsPerBox,
  });
  return {
    id,
    name: displayProductName(product),
    qty,
    qtySummary: formatTrayQty(split.boxes, split.pieces, qty),
    subtotal: computeLineSubtotal({
      unitPrice: line.unitPrice != null ? line.unitPrice : unitPrice,
      qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: product.unitsPerBox ?? null,
    }),
    unitsPerBox: product.unitsPerBox ?? null,
    unlisted: false,
  };
}

export interface TrayRowsInput {
  items: Record<string, TrayLine>;
  unlisted?: readonly TrayUnlistedLine[];
  /** Newest-first product ids, as maintained by {@link bumpScanOrder}. */
  scanOrder: readonly string[];
  lookup: (id: string) => TrayProduct | undefined;
  /** The customer's effective per-selling-unit price for a product. */
  priceFor: (product: TrayProduct) => number;
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
    push(catalogRow(id, line, product, priceFor(product)));
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
