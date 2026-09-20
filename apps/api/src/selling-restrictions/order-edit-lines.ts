/**
 * Selling restrictions (lane R step 2a) — which lines of an order EDIT need the choke point.
 *
 * PURE: no Prisma, no Nest. `OrdersService.updateOrderItems` hands in the order's existing lines
 * plus the incoming `{id, action, qty}` diff payload; this returns the `EditLine[]` for
 * `SellingRestrictionsService.assertLinesSellable`. It mirrors the service's MERGE branch
 * (apps/api/src/orders/orders.service.ts `updateOrderItems`) — branch ORDER included, not just
 * vocabulary — and is deliberately FAIL-CLOSED toward checking whenever a quantity cannot be sized:
 *
 *   - a line that ADDS a product (an id-less line, a substitute, a productId that rides along with
 *     an id but names another product) is emitted with NO `qtyDelta` — always checked;
 *   - a line that changes an EXISTING product's quantity is emitted with `qtyDelta = incoming −
 *     existing`; the choke point only checks `qtyDelta > 0`, so a decrease, an unchanged echo and
 *     a price/notes-only edit never trap an operator into keeping a now-banned product;
 *   - a removal (CANCEL / DELETE **that names a line**) emits nothing. The service tries its
 *     id-less append BEFORE it looks at `action`, so `{productId, qty, action: "CANCEL"}` with no
 *     `id` is a plain ADD there and is emitted here like one.
 *
 * Box sizes: for a boxes/pieces split the service uses the line's `unitsPerBox` snapshot when it has
 * one, else the LIVE product's — never arithmetic on the row. The caller passes `liveUnitsPerBox`
 * (productId → current `unitsPerBox`) for every EXISTING line addressed by id whose snapshot is
 * null (not the payload's productIds); a split it cannot size is emitted UNSIZED (checked), never
 * guessed. A box-UNAWARE line stores selling units (cases), a split writes PIECES: compared in pieces.
 *
 * Known over-block (fail-closed, pinned by specs): lines are sized one by one, never netted, so an
 * edit that RAISES a line of a product while another of it falls (a repack, a grow-and-cancel) is
 * checked; a decrease-only edit is the way out. `existing` must be the lock-time read (a pre-lock
 * read can hide an increase under a concurrent edit).
 */

/**
 * One line for `SellingRestrictionsService.assertLinesSellable` — structurally its `SellableLine`
 * (no `qtyDelta` = a new line, always checked; a number = the net change in quantity). Kept local
 * so this pure module does not depend on the service; TypeScript checks the two agree at call sites.
 */
export interface EditLine {
  productId: string;
  qtyDelta?: number;
}

/** `number | string | Prisma.Decimal`. */
export type DecimalLike = number | string | { toNumber(): number };

/** An `OrderItem` row reduced to what the edit decision reads. */
export interface ExistingLine {
  id: string;
  productId: string | null;
  qty: DecimalLike;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  status: string;
}

/** One entry of an `UpdateOrderItemsDto.items` payload. */
export interface EditItem {
  id?: string;
  productId?: string;
  action?: "CANCEL" | "DELETE" | "UPDATE";
  qty?: number;
  boxes?: number;
  pieces?: number;
  substituteProductId?: string;
}

/** productId → the product's CURRENT catalog `unitsPerBox` (null = a loose / unpacked product). */
export type LiveUnitsPerBox = ReadonlyMap<string, number | null>;

const toNumber = (v: DecimalLike): number =>
  typeof v === "object" && v !== null ? v.toNumber() : Number(v);

/** A cancelled line carries no goods, whatever stale `qty` an older cancel left on the row. */
const existingQty = (line: ExistingLine): number =>
  line.status === "CANCELLED" ? 0 : toNumber(line.qty);

const hasNumber = (n: number | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n);

const hasSplit = (item: EditItem): boolean => (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;

/**
 * The box size the service sizes a split on this line with: the line's own snapshot when it has
 * one (even 1 or 0 — a snapshot of "not boxed" is still the answer), else the live product's.
 * `undefined` = neither is available to this module.
 */
function splitBoxSize(line: ExistingLine, live: LiveUnitsPerBox | undefined): number | undefined {
  if (line.unitsPerBox != null) return Math.trunc(Number(line.unitsPerBox));
  const size = line.productId ? live?.get(line.productId) : undefined;
  return size === undefined ? undefined : Math.trunc(Number(size ?? 0));
}

/**
 * The line an edit of an EXISTING product's line contributes, or `null` when it changes no
 * quantity (a price / notes / reason-only edit).
 */
function existingLineEdit(
  item: EditItem,
  line: ExistingLine & { productId: string },
  live: LiveUnitsPerBox | undefined,
): EditLine | null {
  const before = existingQty(line);
  if (!hasSplit(item)) {
    // A bare quantity keeps the line's own denomination (pieces on a box-split line, selling
    // units on a box-unaware one): both sides are in the same unit.
    return hasNumber(item.qty) ? { productId: line.productId, qtyDelta: item.qty - before } : null;
  }
  const upb = splitBoxSize(line, live);
  if (upb === undefined) return { productId: line.productId }; // cannot size a split: checked
  if (upb <= 1) {
    // A loose product: the service ignores the split and keeps `item.qty ?? stored`.
    return { productId: line.productId, qtyDelta: hasNumber(item.qty) ? item.qty - before : 0 };
  }
  // The service derives the quantity from the split (boxes × upb + pieces); `qty` is ignored
  // whenever a split is present (`normalizeBoxesPieces`), so a stale larger `qty` cannot trap a cut.
  const incoming = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
  // A split writes PIECES; a box-UNAWARE line stores selling units (cases) — compare in pieces.
  const beforePieces = line.boxes == null && line.pieces == null ? before * upb : before;
  return { productId: line.productId, qtyDelta: incoming - beforePieces };
}

/**
 * The lines of a MERGE-mode order edit that the selling-restrictions choke point must see.
 * Merge = the incremental diff the operator / driver editors send (`replaceAll` false or absent).
 */
export function sellableLinesForMergeEdit(
  existing: readonly ExistingLine[],
  items: readonly EditItem[],
  opts: { liveUnitsPerBox?: LiveUnitsPerBox } = {},
): EditLine[] {
  const lines: EditLine[] = [];
  const byId = new Map(existing.map((l) => [l.id, l]));

  for (const item of items) {
    // A removal never needs a check (owner rule: a ban must not keep stock on an order) — but
    // only when it NAMES a line; an id-less "CANCEL" is an append in the service (see header).
    if (item.id && (item.action === "CANCEL" || item.action === "DELETE")) continue;
    // A substitute is a product NEW to the order.
    if (item.substituteProductId) lines.push({ productId: item.substituteProductId });

    if (item.id) {
      const line = byId.get(item.id);
      // The service ignores a productId that rides along with an id; check it anyway (fail
      // closed) whenever it names something other than the line's own product.
      if (item.productId && item.productId !== line?.productId) {
        lines.push({ productId: item.productId });
      }
      // A substituted line changes product — its old product's quantity no longer matters.
      if (!line?.productId || item.substituteProductId) continue;
      const edit = existingLineEdit(
        item,
        { ...line, productId: line.productId },
        opts.liveUnitsPerBox,
      );
      if (edit) lines.push(edit);
      continue;
    }

    if (!item.productId) continue; // unlisted (catalog-free) line: no product to restrict
    // An id-less line is APPENDED as a new line. A known quantity <= 0 (and no split) is never
    // written by the service — nothing is sold, so it is not checked (belt and braces: the DTO's
    // @Min(1) already refuses it); an unsized one is.
    if (!hasSplit(item) && hasNumber(item.qty) && item.qty <= 0) continue;
    lines.push({ productId: item.productId });
  }
  return lines;
}
