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
 * Unit lines (units_v1, #2275 / SA-408): such a line stores PIECES in `qty` and its unit's factor in
 * its own `unitsPerBox`, while an edit of it sends a COUNT of that unit in `qty`. Compared in pieces:
 * incoming count × the HELD row's snapshot factor, so an unchanged re-send after a repack nets 0. A
 * held row with no usable snapshot factor is UNSIZED (checked): the live pack is the PACK's size,
 * never the unit's (SA-408b). Comparing the count to the stored pieces let an increase
 * on a banned product pass as a decrease. A different unit (a staff re-denomination) has another
 * factor, so it is emitted unsized — checked.
 *
 * Known over-block (fail-closed, pinned by specs): lines are sized one by one, never netted, so an
 * edit that RAISES a line of a product while another of it falls (a repack, a grow-and-cancel) is
 * checked; a decrease-only edit is the way out. `existing` must be the lock-time read (a pre-lock
 * read can hide an increase under a concurrent edit).
 */

import { keepsHeldUnit } from "../orders/unit-label-norm";

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
  /** units_v1: set on a line sold by a non-pack unit; its `unitsPerBox` is then that unit's factor. */
  unitLabel?: string | null;
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
  /** units_v1: the unit this edit counts in; `qty` is then a COUNT of it, not pieces. */
  unitLabel?: string | null;
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

/** A `qty` that IS present but unreadable (NaN, Infinity, a string): never "no change" — checked. */
const unreadableQty = (item: EditItem): boolean => item.qty != null && !hasNumber(item.qty);

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
  if (unreadableQty(item)) return { productId: line.productId };
  if ((line.unitLabel ?? "") !== "" && !hasSplit(item)) return unitLineEdit(item, line, before);
  if (!hasSplit(item)) {
    // A bare quantity on a PACK line keeps the line's own denomination (pieces on a box-split
    // line, selling units on a box-unaware one): both sides are in the same unit. A unit line's
    // bare quantity is a COUNT instead — see unitLineEdit.
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
 * #2275 / SA-408(b): an edit of a unit line, compared in PIECES — incoming count × the HELD row's
 * snapshot factor. Another unit (labels compared through THE one normaliser, `norm`) re-denominates
 * the line with a different factor: unsized, checked. A held row with no usable snapshot factor is
 * unsized too: the live pack is the PACK's size, never the unit's (`splitBoxSize`'s live fallback is
 * for pack lines only).
 */
function unitLineEdit(
  item: EditItem,
  line: ExistingLine & { productId: string },
  before: number,
): EditLine | null {
  // #2288 / SA-447 / SA-070: THE keep-held-unit rule the write's resolveLineUnits uses — ABSENT or
  // the same label keeps the held unit; a cleared label (null / "" / blank) or another one
  // re-denominates the line (to the pack or that unit). A re-denomination is unsized: checked.
  if (!keepsHeldUnit(item.unitLabel, line.unitLabel)) return { productId: line.productId };
  if (!hasNumber(item.qty)) return null;
  const factor = line.unitsPerBox == null ? 0 : Math.trunc(Number(line.unitsPerBox));
  if (!(factor >= 1)) return { productId: line.productId };
  return { productId: line.productId, qtyDelta: item.qty * factor - before };
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

/** Who sent a replace-all payload: it decides what a bare `qty` MEANS (see below). */
export type ReplaceActor = "staff" | "buyer" | "driver";

/**
 * The lines of a REPLACE-ALL order edit — the payload IS the full line set (an operator's
 * `replaceAll: true`, or a buyer / non-diff driver payload). The service deletes every line and
 * re-creates the payload's, so per PRODUCT the goods written are compared with the goods carried.
 * Mirrors the service's replace branches:
 *   - an item writes `qty ?? 0`; a qty-less item is a REMOVAL (nothing written), never checked;
 *     `id` / `action` are ignored, a `substituteProductId` is not written but is checked anyway;
 *   - the box size is always the product's LIVE one (`liveUnitsPerBox`, required for every payload
 *     product that has lines on the order; missing ⇒ UNSIZED ⇒ checked). A loose product (size
 *     <= 1) compares raw quantities. Otherwise everything is compared in PIECES:
 *       staff  — a positive split writes boxes × size + pieces (qty ignored); a bare qty is
 *                selling units (cases), × size;
 *       buyer  — the split is only a signal, `qty` is written; those pieces when the product's
 *                lines are piece-denominated or the payload carries a split, else cases;
 *       driver — as buyer, but pieces only when the product's lines are piece-denominated;
 *     an existing box-UNAWARE line stores cases (× size), a box-split line stores pieces; a
 *     cancelled line carries nothing.
 * Caller contract: `existing` = the LOCK-time rows (cancelled and unlisted included);
 * `liveUnitsPerBox` keyed on every payload product that has a non-cancelled line; `actor` from the
 * service's own branch: CUSTOMER → buyer, a non-diff DRIVER payload → driver, `replaceAll` → staff.
 */
export function sellableLinesForReplaceEdit(
  existing: readonly ExistingLine[],
  items: readonly EditItem[],
  opts: { actor: ReplaceActor; liveUnitsPerBox?: LiveUnitsPerBox },
): EditLine[] {
  const lines: EditLine[] = [];
  const byProduct = new Map<string, EditItem[]>();
  for (const item of items) {
    if (item.substituteProductId) lines.push({ productId: item.substituteProductId });
    if (!item.productId) continue; // unlisted line: no product to restrict
    byProduct.set(item.productId, [...(byProduct.get(item.productId) ?? []), item]);
  }

  const staff = opts.actor === "staff";
  for (const [productId, list] of byProduct) {
    const rows = existing.filter((l) => l.productId === productId);
    const current = rows.filter((l) => l.status !== "CANCELLED");
    if (list.some(unreadableQty)) {
      lines.push({ productId }); // an unreadable qty is never a removal
      continue;
    }
    // an item the service writes: a positive qty, or (staff only) a positive split
    if (!list.some((i) => (hasNumber(i.qty) && i.qty > 0) || (staff && hasSplit(i)))) continue;
    if (current.length === 0) {
      lines.push({ productId }); // not on the order: a NEW line
      continue;
    }
    const size = opts.liveUnitsPerBox?.get(productId);
    if (size === undefined) {
      lines.push({ productId }); // cannot size against the live catalog: checked
      continue;
    }
    const upb = Math.trunc(Number(size ?? 0));
    const boxed = upb > 1;
    // The service's `pieceDenominated` reads EVERY row of the product, cancelled ones included.
    const pieceRows = rows.some((l) => l.boxes != null || l.pieces != null);
    // A buyer's bare qty is pieces when the product is piece-denominated OR THIS item carries a
    // split hint (decided per item, like the service); a driver's only when piece-denominated.
    const bareIsPieces = (i: EditItem) =>
      pieceRows || (opts.actor === "buyer" && (i.boxes != null || i.pieces != null));
    let incoming = 0;
    for (const item of list) {
      const bare = hasNumber(item.qty) && item.qty > 0 ? item.qty : 0;
      if (staff) {
        const derived = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
        incoming += boxed && hasSplit(item) ? derived : boxed ? bare * upb : bare;
      } else {
        incoming += boxed && !bareIsPieces(item) ? bare * upb : bare; // the split is only a signal
      }
    }
    const before = current.reduce(
      (sum, l) =>
        sum +
        (boxed && l.boxes == null && l.pieces == null ? existingQty(l) * upb : existingQty(l)),
      0,
    );
    lines.push({ productId, qtyDelta: incoming - before });
  }
  return lines;
}

/** The change-request row fields the at-door approval reads. */
export interface ChangeRequestFacts {
  type: string;
  productId?: string | null;
  orderItemId?: string | null;
  payload?: unknown;
}

/**
 * The lines an at-door change-request approval would ADD sellable quantity to
 * (`OrdersService.approveChangeRequestAtStop`): an `ADD_ITEM` is a new line — or a merge into an
 * existing one — for its product, always checked; a `CHANGE_QTY` is `newQty − the line's qty` in
 * the line's own denomination (an unreadable `newQty` is unsized, checked); `REMOVE_ITEM` and
 * `NOTE` add nothing.
 */
export function sellableLinesForChangeRequest(
  cr: ChangeRequestFacts,
  existing: readonly ExistingLine[],
): EditLine[] {
  const payload = (cr.payload ?? {}) as {
    productId?: string;
    orderItemId?: string;
    newQty?: unknown;
  };
  if (cr.type === "ADD_ITEM") {
    const productId = cr.productId ?? payload.productId;
    return productId ? [{ productId }] : [];
  }
  if (cr.type !== "CHANGE_QTY") return [];
  const line = existing.find((l) => l.id === (cr.orderItemId ?? payload.orderItemId));
  if (!line?.productId) return [];
  const newQty = Number(payload.newQty);
  return [
    Number.isFinite(newQty)
      ? { productId: line.productId, qtyDelta: newQty - existingQty(line) }
      : { productId: line.productId },
  ];
}
