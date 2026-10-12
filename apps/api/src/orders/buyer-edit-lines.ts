import { BadRequestException, ConflictException } from "@nestjs/common";
import { normalizeBoxesPieces, round4, withinStaffOverrideTolerance } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { carriedLineFor } from "./carry-line-category";
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
/**
 * Row 356 (SA-734r2 r-note 5): the fallback above is removed on this date, once the web and mobile buyer
 * clients that send `orderItemId` + `namesLines` are in a released version (otherwise the row moves the date).
 * `buyer-edit-lines.spec.ts` logs a loud (non-failing) warning after it; the date is tracked on row 356.
 */
export const BUYER_EDIT_IDLESS_FALLBACK_REMOVE_ON = "2026-11-15";

export interface StoredEditLine extends FoldTrio {
  id: string;
  productId?: string | null;
  status?: string | null;
  qty: unknown;
  boxes?: unknown;
  pieces?: unknown;
  unitLabel?: string | null;
  overrideReason?: string | null;
  unitPrice?: unknown;
  createdAt?: Date | string | null;
}

export interface BuyerEditEntry {
  productId?: string | null;
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
  orderItemId?: string;
  sourceLineId?: string;
  /**
   * INTERNAL (never a DTO field: `forbidNonWhitelisted` rejects it from a client): what a paired line carries
   * from its stored line (category, trio, createdAt), set by the ONE pairing helper. A builder that cannot read
   * `sourceLineId` through `existingLineById` (the unit-aware `createUnitLine`) overlays this instead.
   */
  carriedLine?: Record<string, unknown>;
  unitPrice?: number;
  overrideReason?: string | null;
}

export interface ResolveBuyerEditArgs {
  /** Receives, per output entry, the index of the input entry it came from (a split yields two for one input). */
  trace?: number[];
  /** A DRIVER's `qty` denomination is the product-wide gate, not the entry's own split (piecesDenominated). */
  role?: "BUYER" | "STAFF" | "DRIVER";
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
 * LINE (`piecesDenominated`, row 355): a `qty` is PIECES when the entry carries an explicit split or names a
 * box-split line, else selling units. A box-unaware stored line holds selling units, so it is expanded by the
 * pack when the payload is in pieces.
 */
function storedQtyInPayloadUnits(
  own: StoredEditLine,
  payloadInPieces: boolean,
  upb: number,
): number {
  const stored = Number(own.qty);
  if (!payloadInPieces) {
    // a box-split line's `qty` is PIECES: an entry read as selling units compares against its whole boxes
    return isBoxSplit(own) && upb > 1 ? stored / upb : stored;
  }
  return isBoxSplit(own) ? stored : stored * (upb > 1 ? upb : 1);
}

function withQty(
  item: BuyerEditEntry,
  qty: number,
  upb: number,
  inPieces: boolean,
): BuyerEditEntry {
  // A half that names no line must say it is in PIECES (an explicit split): the write path reads a plain
  // entry that names no line as selling units, which would bill the added pieces as packs (x unitsPerBox).
  if (inPieces && upb > 1) {
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
  const claimed = new Set<string>();
  // A pre-paired entry (a fold's `sourceLineId`) keeps its line: nothing else may claim it by the fallback.
  for (const it of items) if (it.productId && it.sourceLineId) claimed.add(it.sourceLineId);
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
    if (it.productId && !it.orderItemId && !it.sourceLineId) {
      idlessCount.set(it.productId, (idlessCount.get(it.productId) ?? 0) + 1);
    }
  }

  const out: BuyerEditEntry[] = [];
  let inputIndex = -1;
  const push = (e: BuyerEditEntry) => {
    out.push(e);
    args.trace?.push(inputIndex);
  };
  for (const it of items) {
    inputIndex += 1;
    if (!it.productId || (it.sourceLineId && !it.orderItemId)) {
      push(it); // an unlisted line, or an entry a fold already paired: left exactly as it is
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
      push(rest); // a new line: stamps live in the write
      continue;
    }
    const upb = upbByProduct.get(productId) ?? 0;
    // Row 355: the write path reads the entry like its OWN line (an explicit split is pieces too).
    // The unit `qty` is written in is decided exactly as the write path decides it:
    //  - BUYER (piecesDenominated, isBuyerEdit): pieces when the entry carries ANY boxes/pieces split or its paired
    //    line is box-split;
    //  - STAFF (replace-all-line-build): pieces ONLY for a real (non-zero) boxes/pieces split, never from the
    //    stored line: a plain or zero-split `qty` is selling units;
    //  - DRIVER (piecesDenominated, non-buyer): a paired entry reads like its own line.
    const realSplit = (it.boxes ?? 0) > 0 || (it.pieces ?? 0) > 0;
    const entryInPieces =
      upb > 1 &&
      (args.role === "STAFF"
        ? realSplit
        : args.role === "BUYER"
          ? isBoxSplit(it) || isBoxSplit(own)
          : isBoxSplit(own));
    const have = storedQtyInPayloadUnits(own, entryInPieces, upb);
    // `want`: a STAFF real split is read through normalizeBoxesPieces (the write's own normaliser); the buyer
    // and driver writes always read `qty`.
    const want =
      args.role === "STAFF" && realSplit && upb > 1
        ? normalizeBoxesPieces({
            qty: it.qty,
            boxes: it.boxes,
            pieces: it.pieces,
            unitsPerBox: upb,
          }).qty
        : Number(it.qty ?? 0);
    // The unit the ADDED half is written in. A DRIVER's added half names no line, so the write reads it by the
    // product-wide gate (any box-split line of the product => pieces): expressed in that unit.
    const driverGatePieces =
      args.role === "DRIVER" &&
      upb > 1 &&
      lineItems.some((l) => l.productId === productId && isBoxSplit(l));
    const payloadInPieces = entryInPieces;
    const live2: FoldTrio = liveTrioByProduct.get(productId) ?? { trackedCategoryId: null };
    const carriedLine = carriedLineFor([own as never], { sourceLineId: own.id }, productId);
    // A plain/zero-split STAFF entry on a box-split stored line (which may hold loose pieces: 14 = 2 boxes + 2
    // pieces) is compared AND written in whole PIECES, as explicit splits, never a fractional pack count.
    const piecesCompare = args.role === "STAFF" && upb > 1 && isBoxSplit(own) && !entryInPieces;
    const haveCmp = piecesCompare ? Number(own.qty) : have;
    const wantCmp = piecesCompare ? want * upb : want;
    // A DRIVER's added half on a pack line is written in the pieces the product-wide gate reads; when that is not
    // a whole number of pieces (a fractional pack count) no split is made: the entry is left whole, untouched.
    const driverAdded = driverGatePieces && !isBoxSplit(own) ? round4((want - have) * upb) : null;
    // A half written in PIECES must be a whole number of pieces: a fractional stored pack count (1.5 packs) or a
    // fractional wanted quantity (2.4 packs on a 14-piece line) would truncate in normalizeBoxesPieces and drop
    // quantity or emit an empty half. Such an entry is left whole, as a fractional driver pack count is.
    const writesPieces = piecesCompare || payloadInPieces;
    const wholePieces = !writesPieces || (Number.isInteger(haveCmp) && Number.isInteger(wantCmp));
    const splittable = wholePieces && (driverAdded === null || Number.isInteger(driverAdded));
    if (wantCmp > haveCmp && splittable && foldTarget(own, live2) === "SPLIT") {
      push({
        ...withQty(rest, haveCmp, upb, piecesCompare || payloadInPieces),
        sourceLineId: own.id,
        carriedLine,
      });
      // a sale made today: its own live line, priced by today's rules. A price the entry merely ECHOES from the
      // stored line (and that line's override reason) belongs to THAT line: it is not extended to quantity added
      // later. A price the client actually changed is a decision about the whole entry and stays.
      const echoes =
        rest.unitPrice !== undefined &&
        own.unitPrice != null &&
        withinStaffOverrideTolerance(Number(rest.unitPrice), Number(own.unitPrice));
      const { unitPrice: _price, overrideReason: _reason, ...fresh } = rest;
      void _price;
      void _reason;
      const base = echoes ? fresh : rest;
      push(
        driverAdded !== null
          ? { ...base, qty: driverAdded }
          : withQty(base, wantCmp - haveCmp, upb, piecesCompare || payloadInPieces),
      );
      continue;
    }
    push({ ...rest, sourceLineId: own.id, carriedLine });
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
  dto: { items?: BuyerEditEntry[]; namesLines?: boolean; replaceAll?: boolean },
  user: { role?: string } | undefined,
  opts: { buyerLineIds?: boolean; isCreateMerge?: boolean } | undefined,
  isDiffPayload: boolean,
): void {
  const items = dto.items ?? [];
  // Row 373b: a staff / driver replace payload gets the buyer's strict pairing fallback; its 409 is raised here
  // (before `revertLinkedInvoicesForOrderEdit` commits), through the same helper.
  if (
    !opts?.isCreateMerge &&
    user?.role !== "CUSTOMER" &&
    (user?.role === "DRIVER" ? !isDiffPayload : dto.replaceAll === true)
  )
    preflightEditLinePairing(items, order.lineItems ?? []);
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
    role: "BUYER",
  });
  // The resolver only adds `sourceLineId` and splits an entry in two copies of itself: same shape as `T`.
  items.splice(0, items.length, ...(resolved as unknown as T[]));
}

/**
 * B297 row 355 (SA-734r2 r-note 5): is this entry's `qty` written in PIECES (re-split by the pack and
 * prorated by the BOX price), or in selling units (the pack, never re-split)? Decided per LINE from the
 * line's own stored unit fields, never per product: a product can hold a pack line and a box-split line at
 * once (row 340 splits), and reading the pack line as pieces under-charges it by `unitsPerBox`.
 *  - an entry carrying an explicit boxes/pieces split is in pieces (the split is a signal, re-derived server-side);
 *  - an entry naming a line of this product (`sourceLineId`) reads like that line: box-split => pieces;
 *  - an entry naming none reads like the product's live lines WHEN THEY AGREE (every one box-split => pieces:
 *    the legacy plain qty of a box-split line); with a pack line among them, or none at all, it is a plain
 *    buyer qty = the default selling unit. A DRIVER entry keeps the product-wide gate.
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
): boolean {
  if (isBuyerEdit && (item.boxes != null || item.pieces != null)) return true;
  const lines = lineItems ?? [];
  const own = item.sourceLineId
    ? lines.find((l) => l.id === item.sourceLineId && l.productId === item.productId)
    : undefined;
  if (own) return own.boxes != null || own.pieces != null;
  if (!isBuyerEdit) return !!item.productId && productPieceDenominated.has(item.productId);
  const live = lines.filter((l) => l.productId === item.productId && l.status !== "CANCELLED");
  return live.length > 0 && live.every((l) => l.boxes != null || l.pieces != null);
}

/** Who is editing: the three replace paths share ONE pairing (row 373b). */
export type PairingRole = "BUYER" | "STAFF" | "DRIVER";

/**
 * B297 row 373(b) (SA-734r2 r-note 8): the ONE pairing of a replace payload's entries with the order's stored
 * lines, for the buyer, the staff and the driver edit (a structural pin in `edit-line-pairing.structure.spec.ts`
 * fails if any of the three stops calling it). SA-098a ("a re-created line is a new sale") is superseded by line
 * identity: a line is a NEW SALE only when unpaired or a product substitute. A paired line carries its category,
 * trio and createdAt through `sourceLineId`; added quantity at a different live trio splits (foldTarget); an
 * entry naming no line gets the strict fallback (exactly one unclaimed line of the product and unit carries,
 * two or more are 409 ORDER_EDIT_NEEDS_LINE_IDS). The buyer names a line by `orderItemId`, staff and driver by
 * `id`; an `id` that is not a live line of the product is not a name (it is ignored, never a 400).
 */
export function pairEditLines<T extends BuyerEditEntry & { id?: string }>(
  dto: { items: T[]; namesLines?: boolean },
  order: { lineItems?: ReadonlyArray<StoredEditLine> | null },
  productMap: ReadonlyMap<string, any>,
  categoryMap: ReadonlyMap<string, any>,
  who: PairingRole | { role?: string } | null | undefined,
  opts?: { buyerLineIds?: boolean; isCreateMerge?: boolean },
): void {
  const role: PairingRole =
    typeof who === "string"
      ? who
      : who?.role === "CUSTOMER"
        ? "BUYER"
        : who?.role === "DRIVER"
          ? "DRIVER"
          : "STAFF";
  const lineItems = order.lineItems ?? [];
  // a create() merge arrives already paired by the fold (`sourceLineId`); a buyer pairs only on the items route
  if (opts?.isCreateMerge || (role === "BUYER" && !opts?.buyerLineIds)) return;
  if (role === "BUYER") return applyBuyerEditLines(dto, lineItems, productMap, categoryMap);
  const liveById = new Map(
    lineItems.filter((l) => l.productId && l.status !== "CANCELLED").map((l) => [l.id, l]),
  );
  const liveTrioByProduct = new Map<string, FoldTrio>();
  const upbByProduct = new Map<string, number>();
  for (const [id, p] of productMap) {
    liveTrioByProduct.set(
      id,
      liveTrioFor(p, p.trackedCategoryId ? categoryMap.get(p.trackedCategoryId) : null),
    );
    upbByProduct.set(id, Number(p.unitsPerBox ?? 0));
  }
  const named = dto.items.map((it) => ({
    ...it,
    orderItemId:
      it.orderItemId ??
      (!it.sourceLineId && it.id && liveById.get(it.id)?.productId === it.productId
        ? it.id
        : undefined),
  }));
  const trace: number[] = [];
  const resolved = resolveBuyerEditLines({
    items: named,
    lineItems,
    liveTrioByProduct,
    upbByProduct,
    allowIdlessFallback: true,
    trace,
    role,
  });
  // Keep the ORIGINAL entry objects (updateOrderItems keys its per-item unit rows by object identity): the first
  // output of an input writes its pairing back onto that object; a split's extra half is a new entry.
  const originals = dto.items.slice();
  const seen = new Set<number>();
  const out: T[] = [];
  resolved.forEach((r, k) => {
    const i = trace[k];
    if (seen.has(i)) {
      out.push(r as unknown as T);
      return;
    }
    seen.add(i);
    const orig = originals[i];
    if (r.sourceLineId !== undefined) orig.sourceLineId = r.sourceLineId;
    if (r.carriedLine !== undefined) orig.carriedLine = r.carriedLine;
    if (r.qty !== orig.qty && r.qty !== undefined) orig.qty = r.qty;
    if ((r.boxes ?? null) !== (orig.boxes ?? null)) orig.boxes = r.boxes;
    if ((r.pieces ?? null) !== (orig.pieces ?? null)) orig.pieces = r.pieces;
    out.push(orig);
  });
  dto.items.splice(0, dto.items.length, ...out);
}

/**
 * The refusals alone for a staff / driver replace payload (the strict fallback's 409), run BEFORE
 * `revertLinkedInvoicesForOrderEdit` commits, exactly like the buyer's preflight.
 */
export function preflightEditLinePairing(
  items: ReadonlyArray<BuyerEditEntry & { id?: string }>,
  lineItems: ReadonlyArray<StoredEditLine>,
): void {
  const liveById = new Map(
    lineItems.filter((l) => l.productId && l.status !== "CANCELLED").map((l) => [l.id, l]),
  );
  resolveBuyerEditLines({
    items: items.map((it) => ({
      ...it,
      orderItemId:
        it.orderItemId ??
        (!it.sourceLineId && it.id && liveById.get(it.id)?.productId === it.productId
          ? it.id
          : undefined),
    })),
    lineItems,
    liveTrioByProduct: new Map(),
    upbByProduct: new Map(),
    allowIdlessFallback: true,
  });
}
