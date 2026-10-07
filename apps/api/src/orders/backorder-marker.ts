import {
  backorderPiecesForLine,
  backorderPiecesForLines,
  type BackorderLine,
} from "./oversell-policy";

/**
 * SA-714 R1 / SA-716: the per-line backorder marker (`OrderItem.backorderedPieces`, PIECES).
 * PURE attribution only — no DB, no policy read. It is INFORMATIONAL: written solely from inside the
 * locked stock section (order-stock.ts), never read by money, invoice, stock or status code.
 *
 * Two write semantics, never mixed:
 *  - SET at a fresh sale moment (create, promotion DRAFT->PENDING, reopen from CANCELLED): the marker
 *    is that decrement's own per-line result, whatever it held before (`saleMarkers` / mode "set").
 *  - ADJUST on an edit: an increase adds its backorder delta to that line; a reduction releases
 *    backordered pieces first, `max(0, marker - reduced)` (`editMarkers`, mode "adjust").
 * Cancel and demote write nothing. A recreate-mode edit (new line ids, B1167) loses the marker.
 * Per product, available stock fills lines by `position` asc (null last, then input order) and the
 * remainder lands on the LATER lines. Totals come from the existing pure helpers in oversell-policy.ts.
 */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** position asc, nulls LAST, ties by input index — the one ordering both paths use. */
const byPosition = <T extends { position?: number | null }>(items: T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pa = a.item.position ?? Number.POSITIVE_INFINITY;
      const pb = b.item.position ?? Number.POSITIVE_INFINITY;
      return pa === pb ? a.index - b.index : pa < pb ? -1 : 1;
    })
    .map((x) => x.item);

export interface SaleMarkerLine extends BackorderLine {
  productId: string;
  position?: number | null;
}

/**
 * SET: backordered pieces per sale line, from the pre-decrement `availableByProduct` (the locked
 * `currentStock`, PIECES). Every line of `lines` is in the result (0 when covered). A negative
 * line is a caller bug that must never fail a sale over an informational field: its product
 * is marked 0.
 */
export function saleMarkers<L extends SaleMarkerLine>(args: {
  lines: L[];
  packByProduct: ReadonlyMap<string, number | null | undefined>;
  availableByProduct: ReadonlyMap<string, number>;
  allowOversell: boolean;
}): Map<L, number> {
  const out = new Map<L, number>();
  const byProduct = new Map<string, L[]>();
  for (const l of args.lines)
    byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  for (const [productId, lines] of byProduct) {
    const productPack = args.packByProduct.get(productId) ?? null;
    const available = args.availableByProduct.get(productId) ?? 0;
    let total = 0;
    try {
      total = backorderPiecesForLines({
        lines,
        productPack,
        availablePieces: available,
        allowOversell: args.allowOversell,
      });
    } catch {
      total = 0; // RangeError: a negative line — mark nothing for this product
    }
    if (!(total > 0)) {
      for (const l of lines) out.set(l, 0);
      continue;
    }
    let free = Math.max(0, available);
    for (const l of byPosition(lines)) {
      const pieces = backorderPiecesForLine({
        line: l,
        productPack,
        availablePieces: 0,
        allowOversell: true,
      });
      const filled = Math.min(pieces, free);
      free = round3(free - filled);
      out.set(l, round3(pieces - filled));
    }
  }
  return out;
}

export interface EditMarkerLine {
  id: string;
  position: number | null;
  /** the stored marker (ignored in "set" mode) */
  marker: number;
  /** booked pieces before the edit (0 for a new line) and after it */
  held: number;
  final: number;
}

/**
 * ADJUST / SET for ONE product's lines. `backorder` is the product's total from
 * `backorderPiecesForEditDelta` (its per-product booked delta minus available). Lines that rose
 * absorb it from the LAST position backwards, each capped at its own increase; lines that fell
 * release first. Returns only the lines whose marker changes ("set" mode: every line whose value
 * differs from the stored one).
 */
export function editMarkers(args: {
  lines: EditMarkerLine[];
  backorder: number;
  mode: "adjust" | "set";
}): Map<string, number> {
  const next = new Map<string, number>();
  const ordered = byPosition(args.lines);
  let remaining = Math.max(0, args.backorder);
  const share = new Map<string, number>();
  for (const l of [...ordered].reverse()) {
    const inc = round3(Math.max(0, l.final - l.held));
    const take = Math.min(inc, remaining);
    remaining = round3(remaining - take);
    if (take > 0) share.set(l.id, take);
  }
  for (const l of args.lines) {
    const base = args.mode === "set" ? 0 : l.marker;
    const dec = round3(Math.max(0, l.held - l.final));
    const value = round3(Math.min(Math.max(0, base - dec) + (share.get(l.id) ?? 0), l.final));
    if (value !== round3(l.marker)) next.set(l.id, value);
  }
  return next;
}
