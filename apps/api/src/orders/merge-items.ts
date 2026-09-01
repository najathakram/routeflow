import { normalizeBoxesPieces } from "../common/pricing";

export interface MergeLineSnapshot {
  productId?: string | null;
  name?: string | null;
  // Prisma Decimal on the real OrderItem row (coerced via Number() below) —
  // typed loosely here so this accepts both a live findActiveOrder() payload
  // and a plain test fixture.
  qty: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitPrice?: unknown;
  // PriceType of the existing row — decides whether its unitPrice is an
  // operator OVERRIDE (MANUAL: survives the merge verbatim) or a DERIVED price
  // (STANDARD/SPECIAL/DISCOUNTED/PROMO: omitted so updateOrderItems re-prices
  // at the MERGED quantity — tier breaks and promo selection legitimately
  // change when qty changes, and re-stamping a derived price as a manual
  // override freezes it wrongly forever). R0 of the F30 close-out.
  priceType?: string | null;
  notes?: string | null;
}

export interface MergeIncomingItem {
  productId?: string;
  name?: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  notes?: string;
}

/**
 * Box size for one box-carrying row, WITHOUT a product lookup.
 *
 * `OrderItem.unitsPerBox` is only snapshotted on box-split lines and is
 * explicitly null on lines created before that snapshot shipped (schema
 * comment: "fall back to live upb"). Treating a null as 0 is what silently
 * collapsed a boxed line to its loose pieces, so fall back to the row's own
 * arithmetic instead: a box-carrying row states its TOTAL pieces in `qty`, so
 * `(qty - pieces) / boxes` IS the box size that row was written with. Returns
 * 0 when nothing resolves — callers must then pass boxes/pieces through
 * untouched and let updateOrderItems re-derive from the LIVE product.
 */
export function deriveUnitsPerBox(row: {
  qty?: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): number {
  const snapshot = Math.trunc(Number(row.unitsPerBox ?? 0));
  if (snapshot > 1) return snapshot;
  const boxes = Math.trunc(Number(row.boxes ?? 0));
  if (boxes > 0) {
    const totalPieces = Math.trunc(Number(row.qty ?? 0));
    const loosePieces = Math.trunc(Number(row.pieces ?? 0));
    const derived = (totalPieces - loosePieces) / boxes;
    if (Number.isInteger(derived) && derived > 1) return derived;
  }
  return 0;
}

/**
 * F30/R11 (B199): fold an incoming scan/add batch into an existing order's
 * lines WITHOUT flattening denominations. A box-split line stores its qty in
 * PIECES (boxes × unitsPerBox + pieces) — summing that flat against a plain
 * qty (or against another product's box count) mixed units and, worse, fed
 * the wrong number into box-price proration (a 2-box + 5-piece line became
 * 7 BOXES, repriced ×unitsPerBox). Boxes fold with boxes, pieces fold with
 * pieces, an incoming item with no box data is loose pieces, and
 * normalizeBoxesPieces re-derives the canonical split (with rollover) exactly
 * like every other money-math path in this codebase. unitPrice/notes are
 * preserved from the EXISTING line — a merge is never where an operator's
 * price override or line note silently disappears.
 *
 * The result is the order's COMPLETE new line set (absolute totals, not a
 * delta), so the caller must hand it to updateOrderItems as an explicit
 * `replaceAll: true` — see the merge branch below.
 */
export function foldMergeItems(
  existingLines: MergeLineSnapshot[],
  incoming: MergeIncomingItem[],
): Array<Record<string, unknown>> {
  const byProduct = new Map<
    string,
    {
      boxes: number;
      pieces: number;
      unitsPerBox: number;
      /** Any side of this fold carried a boxes/pieces split. */
      boxAware: boolean;
      /** The order already had a line for this product… */
      hadExisting: boolean;
      /** …and that line was itself box-split. */
      existingBoxAware: boolean;
      unitPrice?: number;
      existingPriceType?: string | null;
      notes?: string | null;
    }
  >();
  // Unlisted lines (no productId) can't be keyed by product — pass them
  // through as their own line items so a merge never drops them.
  const unlisted: Array<{ name?: string; qty: number; unitPrice: number; notes?: string }> = [];

  for (const li of existingLines) {
    if (!li.productId) {
      unlisted.push({
        name: li.name ?? undefined,
        qty: Number(li.qty),
        unitPrice: Number(li.unitPrice ?? 0),
        ...(li.notes ? { notes: li.notes } : {}),
      });
      continue;
    }
    const hasBoxData = li.boxes != null || li.pieces != null;
    byProduct.set(li.productId, {
      boxes: hasBoxData ? Number(li.boxes ?? 0) : 0,
      // A plain (box-unaware) line's whole qty folds in as loose pieces.
      pieces: hasBoxData ? Number(li.pieces ?? 0) : Number(li.qty ?? 0),
      unitsPerBox: deriveUnitsPerBox(li),
      boxAware: hasBoxData,
      hadExisting: true,
      existingBoxAware: hasBoxData,
      unitPrice: li.unitPrice != null ? Number(li.unitPrice) : undefined,
      existingPriceType: li.priceType ?? null,
      notes: li.notes ?? null,
    });
  }

  for (const item of incoming) {
    if (!item.productId) {
      unlisted.push({
        name: item.name,
        qty: item.qty,
        unitPrice: item.unitPrice ?? 0,
        ...(item.notes ? { notes: item.notes } : {}),
      });
      continue;
    }
    const incomingHasBoxData = item.boxes != null || item.pieces != null;
    // A scanned case arrives as {qty: totalPieces, boxes, pieces}, so the
    // incoming item states its own box size even for a product that isn't on
    // the order yet — no lookup needed.
    const incomingUnitsPerBox = deriveUnitsPerBox(item);
    const acc = byProduct.get(item.productId);
    if (!acc) {
      // Brand-new line for this merge — no existing accumulator to fold into.
      byProduct.set(item.productId, {
        boxes: incomingHasBoxData ? Number(item.boxes ?? 0) : 0,
        pieces: incomingHasBoxData ? Number(item.pieces ?? 0) : Number(item.qty ?? 0),
        unitsPerBox: incomingUnitsPerBox,
        boxAware: incomingHasBoxData,
        hadExisting: false,
        existingBoxAware: false,
        unitPrice: item.unitPrice,
        notes: item.notes ?? null,
      });
      continue;
    }
    acc.boxes += incomingHasBoxData ? Number(item.boxes ?? 0) : 0;
    acc.pieces += incomingHasBoxData ? Number(item.pieces ?? 0) : Number(item.qty ?? 0);
    if (incomingHasBoxData) acc.boxAware = true;
    if (acc.unitsPerBox <= 1 && incomingUnitsPerBox > 1) acc.unitsPerBox = incomingUnitsPerBox;
    // R11: the EXISTING line's price/note win — a merge never overwrites an
    // operator's override with the client's freshly-resolved catalog price.
    // Incoming values only FILL what the existing line doesn't carry (and are
    // the only source for a brand-new merged line, handled above).
    if (acc.unitPrice == null && item.unitPrice != null) acc.unitPrice = item.unitPrice;
    if (!acc.notes && item.notes) acc.notes = item.notes;
  }

  const merged: Array<Record<string, unknown>> = [];
  for (const [productId, acc] of byProduct.entries()) {
    let qty = acc.pieces;
    let boxes: number | null = null;
    let pieces: number | null = null;
    if (acc.boxAware && acc.unitsPerBox > 1) {
      const norm = normalizeBoxesPieces({
        boxes: acc.boxes,
        pieces: acc.pieces,
        unitsPerBox: acc.unitsPerBox,
      });
      qty = norm.qty;
      boxes = norm.boxes;
      pieces = norm.pieces;
    } else if (acc.boxAware) {
      // Box data with no resolvable box size. NEVER drop the boxes (that is
      // the silent-loss bug): hand the raw split down so updateOrderItems
      // re-derives the canonical split + qty from the LIVE product.
      boxes = acc.boxes;
      pieces = acc.pieces;
    }
    // A plain existing line's unitPrice is a PIECE price; once the merged line
    // becomes box-split the same number would be read as a BOX price and
    // prorated. Drop it instead so updateOrderItems re-prices the line from
    // the catalog/tier ladder in the right denomination.
    // Denomination rule (unchanged) AND the override rule (R0): an existing
    // line's price survives only when the operator set it by hand (MANUAL) —
    // derived prices re-derive at the merged quantity. A brand-new merged line
    // keeps the incoming price (create-path semantics, unchanged).
    const denominationOk = !(acc.hadExisting && !acc.existingBoxAware && acc.boxAware);
    const overrideOk = !acc.hadExisting || acc.existingPriceType === "MANUAL";
    const priceSurvives = denominationOk && overrideOk;
    merged.push({
      productId,
      qty,
      ...(boxes != null ? { boxes } : {}),
      ...(pieces != null ? { pieces } : {}),
      ...(acc.unitPrice != null && priceSurvives ? { unitPrice: acc.unitPrice } : {}),
      ...(acc.notes ? { notes: acc.notes } : {}),
    });
  }

  return [...merged, ...unlisted];
}

/**
 * B47 (REG-B47): a box-UNAWARE line (boxes/pieces null) of a BOXED product
 * states its qty in SELLING UNITS — pricing.ts's contract: unitPrice IS the
 * box price and computeLineSubtotal bills unitPrice x qty. Folding that qty as
 * loose pieces mis-bills it (~1/unitsPerBox of its value); summing it raw with
 * pieces over-bills ~unitsPerBox x. Normalize such snapshots to an explicit
 * box split BEFORE folding, using the LIVE unitsPerBox the caller supplies.
 * Non-boxed products (upb <= 1) and already-split lines pass through untouched.
 *
 * A selling-unit count is NOT necessarily whole (`OrderItem.qty` is
 * Decimal(10,3) and the DTO only asks for `@IsNumber`), so the expansion must
 * not truncate: 2.5 cases of a upb-12 product is 30 pieces = 2 boxes + 6 loose
 * pieces, and rounding it down to 2 boxes would silently bin half a case of
 * the buyer's money. Expand exactly like the other readers of this shape
 * (`linePieceQty`, `mergeBoxedContributions`: `qty x upb`) and hand the result
 * to `normalizeBoxesPieces` — the fold's own quantity hygiene — so the
 * remainder survives as loose pieces.
 *
 * SCOPE — this rewrites the STORED side only, and only for products the
 * incoming payload denominates explicitly. The two sides of the fold do NOT
 * share a bare-qty convention: `foldMergeItems` reads an incoming
 * `{productId, qty}` as loose PIECES (correct for the staff scan path, where a
 * bare qty is one scanned unit), while a BUYER client states a bare qty in
 * SELLING UNITS (create() stores it box-unaware and bills it x the BOX price —
 * see buyer/shelf.service.ts `lowItems()` and mobile lib/shelf-logic.ts).
 * Rewriting the stored side while the incoming side stays bare is therefore its
 * own mis-bill: a box-unaware 2 (= 2 boxes) plus a bare incoming 2 folds to 2
 * boxes + 2 loose PIECES instead of 4 boxes.
 *
 * The halves are reconciled per denomination pair, never by rewriting one side
 * into the other's language wholesale:
 *   - stored box-UNAWARE + incoming box-AWARE -> normalize the stored line HERE.
 *   - stored box-UNAWARE + incoming BARE -> leave both alone; the stored qty
 *     folds in as `pieces` and the bare incoming qty is added to that same
 *     accumulator, so both sides really are counting selling units.
 *   - stored box-SPLIT + incoming BARE -> that accumulator is in PIECES, so the
 *     two do NOT agree; `normalizeBareIncomingSellingUnits` (below) expands the
 *     INCOMING side instead.
 *
 * ⚠️ NOT exhaustive, and deliberately so — two gaps this module does NOT close:
 *
 *   1. NO stored line + incoming BARE qty. Nothing here touches it, and
 *      `updateOrderItems`' buyer branch then re-splits it as loose PIECES
 *      (`isBuyerEdit && !existingProductIds.has(productId)` — a pre-F06 clause
 *      that exists to stop a bare qty being stored as a BOX count). So a bare
 *      buyer qty means SELLING UNITS everywhere above but PIECES for a product
 *      new to the order: mobile Reorder of a box-unaware past line (bare qty 2
 *      of a upb-12 product) bills 2/12 of a box. Settling it needs a client
 *      contract decision, not a tweak here — filed for a later batch, and F06
 *      leaves that path exactly as it found it.
 *   2. The STAFF caller does not normalize its stored side. `foldMergeItems`'
 *      other call site — `orders.controller.ts`' POST /orders scan-merge — is
 *      frozen byte-identical by F06's R12 and still reads a stored box-unaware
 *      qty as loose pieces (2 boxes + a scanned case bills $11.67 where the
 *      goods are $30). Normalizing there is one import away but is NOT this
 *      batch's fence; also filed. Do not assume a caller of this module is
 *      denomination-safe just because these normalizers exist.
 */
export function normalizeBoxUnawareSnapshots(
  lines: MergeLineSnapshot[],
  liveUnitsPerBoxByProductId: Map<string, number>,
): MergeLineSnapshot[] {
  return lines.map((li) => {
    if (!li.productId || li.boxes != null || li.pieces != null) return li;
    const upb = Math.trunc(Number(liveUnitsPerBoxByProductId.get(li.productId) ?? 0));
    if (upb <= 1) return li;
    const sellingUnits = Number(li.qty ?? 0);
    if (!(sellingUnits > 0)) return li;
    const norm = normalizeBoxesPieces({ qty: sellingUnits * upb, unitsPerBox: upb });
    return { ...li, boxes: norm.boxes, pieces: norm.pieces, qty: norm.qty, unitsPerBox: upb };
  });
}

/**
 * B47 (REG-B47), the INCOMING half of the same denomination reconciliation.
 *
 * A buyer's bare `{productId, qty}` counts SELLING UNITS, but `foldMergeItems`
 * adds a bare qty to the accumulator's `pieces`. That is harmless while the
 * stored line is box-UNAWARE (its own qty sits in `pieces` too, so both sides
 * are counting selling units), and a mis-bill the moment the stored line is
 * box-SPLIT — the normal shape after any web/mobile cart add, which sends
 * `{qty: boxes x upb, boxes, pieces}`. Stored {boxes:2, pieces:0, qty:24,
 * unitsPerBox:12} plus a bare incoming 2 (mobile Reorder copies a box-UNAWARE
 * past line forward as exactly that shape) folds to {qty:26, boxes:2, pieces:2}
 * and bills 2 + 2/12 boxes where the buyer ordered 4.
 *
 * So when the stored line is box-split, expand the bare incoming selling units
 * into an explicit split against the LIVE unitsPerBox — `qty x upb` pieces
 * through `normalizeBoxesPieces`, the same expansion the stored-side normalizer
 * uses, so a fractional selling-unit count survives as loose pieces rather than
 * truncating. Everything else passes through untouched: an incoming item that
 * already carries its own split, an unlisted item, a product with no stored
 * line or a box-unaware one, and a non-boxed product (live upb <= 1).
 */
export function normalizeBareIncomingSellingUnits(
  incoming: MergeIncomingItem[],
  existingLines: MergeLineSnapshot[],
  liveUnitsPerBoxByProductId: Map<string, number>,
): MergeIncomingItem[] {
  const boxSplitStored = new Set(
    existingLines
      .filter((li) => li.productId && (li.boxes != null || li.pieces != null))
      .map((li) => li.productId as string),
  );
  return incoming.map((item) => {
    if (!item.productId || item.boxes != null || item.pieces != null) return item;
    if (!boxSplitStored.has(item.productId)) return item;
    const upb = Math.trunc(Number(liveUnitsPerBoxByProductId.get(item.productId) ?? 0));
    if (upb <= 1) return item;
    const sellingUnits = Number(item.qty ?? 0);
    if (!(sellingUnits > 0)) return item;
    const norm = normalizeBoxesPieces({ qty: sellingUnits * upb, unitsPerBox: upb });
    return { ...item, qty: norm.qty, boxes: norm.boxes ?? 0, pieces: norm.pieces ?? 0 };
  });
}
