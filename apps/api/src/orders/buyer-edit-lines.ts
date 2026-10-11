import { BadRequestException, ConflictException } from "@nestjs/common";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { foldTarget, liveTrioFor, type FoldTrio } from "./fold-target";

/**
 * B297 row 352 (SA-734r2 r-note 4): the buyer's PATCH /buyer/orders/:id/items names each existing line it
 * edits (`orderItemId`). After row 340 the same product can sit on two lines sold at different rate trios, so
 * the edit can no longer identify a line by product, and a payload that did used to re-stamp every line from
 * the product's CURRENT category (the sale-time excise lost). Each entry resolves to one of:
 *
 *  - an `orderItemId` on THIS order, of the same product: that line. It is carried to the replace-all write
 *    through the internal `sourceLineId` (the fold's own channel, resolved against the pre-edit lines), so it
 *    keeps its category and trio exactly as a fold's line does. MORE quantity than the line holds, at a trio
 *    that differs from today's (`foldTarget` says SPLIT), keeps the stored quantity on the line and puts the
 *    added quantity on a NEW live-stamped line; fewer or equal quantity stays on the line at its own trio;
 *  - no id: a new line stamped live. LEGACY FALLBACK (one dated release, `BUYER_EDIT_IDLESS_FALLBACK`), ONLY
 *    for a client that does not say `namesLines`: an id-less entry with exactly ONE unclaimed line of the
 *    same product and unit is that line; with two or more it is refused 409 ORDER_EDIT_NEEDS_LINE_IDS (a
 *    refresh gives the client the ids), never guessed;
 *  - an id that is not a live line of this order, or belongs to another product: 400, nothing written.
 *
 * Pure: the caller (updateOrderItems' buyer branch) hands it the pre-edit lines and the live trios already
 * loaded in its transaction, and splices the result back into the payload.
 */
export const BUYER_EDIT_IDLESS_FALLBACK = true;

export interface StoredEditLine extends FoldTrio {
  id: string;
  productId?: string | null;
  status?: string | null;
  qty: unknown;
  boxes?: unknown;
  pieces?: unknown;
  unitLabel?: string | null;
}

export interface BuyerEditEntry {
  productId?: string | null;
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
  orderItemId?: string;
  sourceLineId?: string;
}

export interface ResolveBuyerEditArgs {
  items: BuyerEditEntry[];
  lineItems: ReadonlyArray<StoredEditLine>;
  liveTrioByProduct: ReadonlyMap<string, FoldTrio>;
  upbByProduct: ReadonlyMap<string, number>;
  allowIdlessFallback?: boolean;
}

const isBoxSplit = (l: { boxes?: unknown; pieces?: unknown }) =>
  l.boxes != null || l.pieces != null;

/**
 * The stored line's quantity in the unit the payload's `qty` is written in. The write path decides that per
 * PRODUCT, not per line (updateOrderItems' `pieceDenominated`): a plain `qty` is PIECES when any live line of
 * the product is box-split (or the entry carries an explicit split), else selling units. A box-unaware stored
 * line holds selling units, so it is expanded by the pack when the payload is in pieces.
 */
function storedQtyInPayloadUnits(
  own: StoredEditLine,
  payloadInPieces: boolean,
  upb: number,
): number {
  const stored = Number(own.qty);
  if (!payloadInPieces) return stored;
  return isBoxSplit(own) ? stored : stored * (upb > 1 ? upb : 1);
}

function withQty(item: BuyerEditEntry, qty: number, upb: number): BuyerEditEntry {
  if (isBoxSplit(item) && upb > 1) {
    const split = normalizeBoxesPieces({ qty, unitsPerBox: upb });
    return { ...item, qty: split.qty, boxes: split.boxes, pieces: split.pieces };
  }
  return { ...item, qty };
}

export function resolveBuyerEditLines(args: ResolveBuyerEditArgs): BuyerEditEntry[] {
  const { items, lineItems, liveTrioByProduct, upbByProduct } = args;
  const allowFallback = args.allowIdlessFallback ?? BUYER_EDIT_IDLESS_FALLBACK;
  const live = lineItems.filter((l) => l.productId && l.status !== "CANCELLED");
  const byId = new Map(live.map((l) => [l.id, l]));
  const boxSplitProducts = new Set(live.filter(isBoxSplit).map((l) => l.productId as string));
  const claimed = new Set<string>();
  for (const it of items) {
    if (!it.productId || !it.orderItemId) continue;
    const own = byId.get(it.orderItemId);
    if (!own) {
      throw new BadRequestException(`orderItemId ${it.orderItemId} is not a line of this order`);
    }
    if (own.productId !== it.productId) {
      throw new BadRequestException(`orderItemId ${it.orderItemId} is a line of another product`);
    }
    if (claimed.has(own.id)) {
      throw new BadRequestException(`orderItemId ${it.orderItemId} appears more than once`);
    }
    claimed.add(own.id);
  }
  const idlessCount = new Map<string, number>();
  for (const it of items) {
    if (it.productId && !it.orderItemId) {
      idlessCount.set(it.productId, (idlessCount.get(it.productId) ?? 0) + 1);
    }
  }

  const out: BuyerEditEntry[] = [];
  for (const it of items) {
    if (!it.productId) {
      out.push(it);
      continue;
    }
    const productId = it.productId;
    let own: StoredEditLine | undefined = it.orderItemId ? byId.get(it.orderItemId) : undefined;
    if (!own && allowFallback) {
      const candidates = live.filter(
        (l) =>
          l.productId === productId &&
          !claimed.has(l.id) &&
          (l.unitLabel ?? null) === (it.unitLabel ?? null),
      );
      if (candidates.length > 1 || (candidates.length === 1 && idlessCount.get(productId)! > 1)) {
        throw new ConflictException({
          code: API_ERROR_CODES.ORDER_EDIT_NEEDS_LINE_IDS,
          message: "This order has more than one line for the same product. Refresh and try again.",
        });
      }
      own = candidates[0];
      if (own) claimed.add(own.id);
    }
    const { orderItemId: _drop, ...rest } = it;
    void _drop;
    if (!own) {
      out.push(rest); // a new line: stamps live in the write
      continue;
    }
    const upb = upbByProduct.get(productId) ?? 0;
    const payloadInPieces = upb > 1 && (isBoxSplit(it) || boxSplitProducts.has(productId));
    const have = storedQtyInPayloadUnits(own, payloadInPieces, upb);
    const want = Number(it.qty ?? 0);
    const live2: FoldTrio = liveTrioByProduct.get(productId) ?? { trackedCategoryId: null };
    if (want > have && foldTarget(own, live2) === "SPLIT") {
      out.push({ ...withQty(rest, have, upb), sourceLineId: own.id });
      out.push(withQty(rest, want - have, upb)); // a sale made today: its own live-stamped line
      continue;
    }
    out.push({ ...rest, sourceLineId: own.id });
  }
  return out;
}

/**
 * The refusals alone, with nothing resolved: run BEFORE `revertLinkedInvoicesForOrderEdit` commits (it runs
 * on its own connection ahead of the edit transaction), so a refused edit never leaves a SENT invoice
 * reverted to DRAFT with no edit to re-sync it. Same data and same rules as the in-transaction resolve, so
 * a payload that passes here cannot refuse there.
 */
export function preflightBuyerEditLines(
  items: ReadonlyArray<BuyerEditEntry>,
  lineItems: ReadonlyArray<StoredEditLine>,
  namesLines?: boolean,
): void {
  resolveBuyerEditLines({
    items: [...items],
    lineItems,
    liveTrioByProduct: new Map(),
    upbByProduct: new Map(),
    allowIdlessFallback: !namesLines,
  });
}

/**
 * The service's one pre-commit call (before `revertLinkedInvoicesForOrderEdit`): on the buyer's items edit the
 * refusals run now, anywhere else an `orderItemId` is refused rather than ignored.
 */
export function guardBuyerEditLineIds(
  order: { lineItems?: ReadonlyArray<StoredEditLine> | null },
  dto: { items?: BuyerEditEntry[]; namesLines?: boolean },
  user: { role?: string } | undefined,
  opts: { buyerLineIds?: boolean } | undefined,
  isDiffPayload: boolean,
): void {
  const items = dto.items ?? [];
  // A diff payload (a per-line change by `id`) is not the replace-by-line contract: never silently ignored.
  if (!opts?.buyerLineIds || isDiffPayload) assertNoOrderItemIdOutsideBuyerEdit(items);
  else if (user?.role === "CUSTOMER") {
    preflightBuyerEditLines(items, order.lineItems ?? [], dto.namesLines);
  }
}

/** `orderItemId` means something only on the buyer's items edit; anywhere else it is refused, never ignored. */
export function assertNoOrderItemIdOutsideBuyerEdit(items: ReadonlyArray<BuyerEditEntry>): void {
  if (items.some((i) => i.orderItemId)) {
    throw new BadRequestException("orderItemId is only valid on a buyer's items edit; use id");
  }
}

/**
 * The buyer branch's one call: resolves `items` against the pre-edit lines (see the header) and splices the
 * result back into the SAME array, so every later reader of `dto.items` sees the line ids and the split.
 * `productMap` / `categoryMap` are the branch's own loads (the products in the payload and their categories).
 * `dto.namesLines`: the client names every existing line, so an id-less entry is always a new line.
 */
export function applyBuyerEditLines<T extends BuyerEditEntry>(
  dto: { items: T[]; namesLines?: boolean },
  lineItems: ReadonlyArray<StoredEditLine>,
  productMap: ReadonlyMap<string, any>,
  categoryMap: ReadonlyMap<string, any>,
): void {
  const { items } = dto;
  const liveTrioByProduct = new Map<string, FoldTrio>();
  const upbByProduct = new Map<string, number>();
  for (const [id, p] of productMap) {
    liveTrioByProduct.set(
      id,
      liveTrioFor(p, p.trackedCategoryId ? categoryMap.get(p.trackedCategoryId) : null),
    );
    upbByProduct.set(id, Number(p.unitsPerBox ?? 0));
  }
  const resolved = resolveBuyerEditLines({
    items,
    lineItems,
    liveTrioByProduct,
    upbByProduct,
    allowIdlessFallback: !dto.namesLines,
  });
  // The resolver only adds `sourceLineId` and splits an entry in two copies of itself: same shape as `T`.
  items.splice(0, items.length, ...(resolved as unknown as T[]));
}
