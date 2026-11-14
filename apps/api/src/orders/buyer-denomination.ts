/**
 * The pack-or-pieces decision of a replace edit, in one PURE module (no Nest, no Prisma), so the write
 * (`updateOrderItems`) and the selling-limit mirror (`selling-restrictions/order-edit-lines.ts`) read an entry
 * through the same function (SA-1118 MUST-1). Moved here unchanged from `buyer-edit-lines.ts` and
 * `order-edit-cancelled.ts`, which re-export them.
 */

/** SA-422 (3): the live lines — the only ones that may decide a fresh add's denomination. */
export const liveLines = <T extends { status?: string | null }>(lines: readonly T[]): T[] =>
  lines.filter((l) => l.status !== "CANCELLED");

/**
 * B297 row 355 (SA-734r2 r-note 5): is this entry's `qty` written in PIECES (re-split by the pack and
 * prorated by the BOX price), or in selling units (the pack, never re-split)? Decided per LINE from the
 * line's own stored unit fields, never per product: a product can hold a pack line and a box-split line at
 * once (row 340 splits), and reading the pack line as pieces under-charges it by `unitsPerBox`.
 *  - an entry carrying an explicit boxes/pieces split is in pieces (the split is a signal, re-derived server-side);
 *  - an entry naming a line of this product (`sourceLineId`) reads like that line: box-split => pieces;
 *  - SA-1118: an entry naming none, from an editor that names its lines (`namesLines`), is the pack: a plain
 *    buyer qty = the default selling unit, whatever the product's other lines hold;
 *  - an entry naming none from a legacy editor (`namesLines` false) reads like the product's live lines when
 *    they agree (every one box-split => pieces: the legacy plain qty of a box-split line); with a pack line
 *    among them, or none at all, it is the pack. A DRIVER entry keeps the product-wide gate.
 */
export function piecesDenominated(
  lineItems:
    | ReadonlyArray<{
        id?: string | null;
        productId?: string | null;
        status?: string | null;
        boxes?: unknown;
        pieces?: unknown;
      }>
    | null
    | undefined,
  item: { productId?: string | null; boxes?: unknown; pieces?: unknown; sourceLineId?: string },
  productPieceDenominated: ReadonlySet<string>,
  isBuyerEdit: boolean,
  namesLines: boolean,
): boolean {
  if (isBuyerEdit && (item.boxes != null || item.pieces != null)) return true;
  const lines = lineItems ?? [];
  const own = item.sourceLineId
    ? lines.find((l) => l.id === item.sourceLineId && l.productId === item.productId)
    : undefined;
  if (own) return own.boxes != null || own.pieces != null;
  if (!isBuyerEdit) return !!item.productId && productPieceDenominated.has(item.productId);
  if (namesLines) return false;
  const live = lines.filter((l) => l.productId === item.productId && l.status !== "CANCELLED");
  return live.length > 0 && live.every((l) => l.boxes != null || l.pieces != null);
}

/**
 * The pack-or-pieces gate of one replace save (`updateOrderItems`), built once. A boxed line's incoming `qty`
 * is only PIECES when a line of the product was stored with a box/piece split (box-aware create). Lines created
 * box-UNAWARE (mobile cart, operator add-line) store `qty` as a selling-unit/box count with boxes=null; those
 * must NOT re-split, or a $120 (2-box) line would drop to $20 (2-piece) on any edit. SA-422 (3): a buyer's fresh
 * add is never denominated by a seller-CANCELLED line (`liveLines`). `products` and `namesLines` feed the promo
 * planners, so they read the same request flag as the write; `isPieces` is `piecesDenominated` for one entry.
 */
export function denominationGate(
  lineItems: Parameters<typeof piecesDenominated>[0],
  isBuyerEdit: boolean,
  namesLines: boolean,
) {
  const lines = lineItems ?? [];
  const products: ReadonlySet<string> = new Set(
    (isBuyerEdit ? liveLines(lines) : lines)
      .filter((li) => li.productId && (li.boxes != null || li.pieces != null))
      .map((li) => li.productId as string),
  );
  return {
    products,
    namesLines,
    isPieces: (item: Parameters<typeof piecesDenominated>[1]) =>
      piecesDenominated(lineItems, item, products, isBuyerEdit, namesLines),
  };
}
