import { ConflictException } from "@nestjs/common";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { foldTarget, type FoldTrio } from "./fold-target";

export interface MergeLineSnapshot {
  // SA-124f: the row's own id — carried through to the fold's output as `sourceLineId`, so a
  // caller comparing "is this line's price actually changing" can key by the SPECIFIC line
  // instead of by productId (which the SA-124a/SA-124c two-pack shape makes ambiguous: two
  // existing lines of one product at two different prices, one bucket per line).
  id?: string | null;
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
  // B465: the existing row's documented reason for a MANUAL override. Must
  // travel WITH unitPrice (never separately) — a MANUAL-priced line on a
  // SPECIAL-tier product that folds through with its price but not its reason
  // would trip updateOrderItems's "a price change on a SPECIAL line needs a
  // reason" refusal on every future merge, even though nothing here is
  // actually changing the price.
  overrideReason?: string | null;
  // B297 row 340: the line's own category and rate trio (a full OrderItem row carries them). They decide, via
  // `foldTarget`, whether an incoming quantity may be ADDED to this line or must go on a new live-stamped one.
  trackedCategoryId?: string | null;
  categoryTaxType?: unknown;
  categoryTaxRate?: unknown;
  categoryPriceIncludesTax?: boolean | null;
}

export interface MergeIncomingItem {
  productId?: string;
  name?: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  /** #2696(c): the reason for a staff-typed price — travels with that price (SA-558d). */
  overrideReason?: string;
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
export interface FoldMergeItemsResult {
  items: Array<Record<string, unknown>>;
  /**
   * SA-124: product ids whose merged bucket carries box data but no pack it could resolve on
   * its own (`deriveUnitsPerBox` === 0 on every contribution) — `updateOrderItems` resolves it
   * against the LIVE product pack downstream (unchanged deferred-fallback behavior; this
   * function never looks the live pack up itself). Surfaced so the caller can warn, mirroring
   * the sweep path's `livePackFallback` signal for the same SA-101(a) branch-4 condition.
   */
  livePackFallbackProductIds: string[];
}

type FoldAcc = {
  boxes: number;
  pieces: number;
  unitsPerBox: number;
  /** Any side of this fold carried a boxes/pieces split. */
  boxAware: boolean;
  /** The order already had a line for this product… */
  hadExisting: boolean;
  /** …and that line was itself box-split. */
  existingBoxAware: boolean;
  /** SA-124f: the SPECIFIC existing line that seeded this bucket, if any — a bucket now
   * corresponds to at most ONE existing line (SA-124e MED-5's per-line buckets), so this is
   * never ambiguous the way a productId-keyed lookup is under the two-pack shape. */
  sourceLineId?: string;
  unitPrice?: number;
  existingPriceType?: string | null;
  notes?: string | null;
  overrideReason?: string | null;
  /**
   * B297 row 340: the trio this bucket's line was sold at (`undefined` for a bucket born in this fold: its
   * units are priced live, so the incoming trio always matches it). Read by `foldTarget`.
   */
  trio?: FoldTrio;
};

export function foldMergeItems(
  existingLines: MergeLineSnapshot[],
  incoming: MergeIncomingItem[],
  // SA-124e(3): needed only to decide whether a bucket's price re-derives (bucket pack ==
  // live pack) or survives as-is (bucket pack != live pack). Optional, defaulting to empty —
  // a caller that omits it gets the pre-SA-124e behavior (price re-derives whenever the line
  // wasn't a stored MANUAL override, regardless of pack).
  liveUnitsPerBoxByProductId: Map<string, number> = new Map(),
  // B297 row 340 (SA MED-3): the trio a NEW sale of each incoming product would be stamped with today.
  // When an existing line's own trio differs (`foldTarget`), the incoming quantity does NOT fold into it: it
  // becomes its own new live-stamped line. Omitted => every fold adds, exactly as before.
  liveTrioByProductId: Map<string, FoldTrio> = new Map(),
): FoldMergeItemsResult {
  // SA-124a/SA-124e MED-5: keyed by productId -> a LIST of buckets, one per EXISTING LINE (never
  // collapsed by pack) plus one per genuinely new pack an incoming item introduces. Two existing
  // lines at the SAME resolved pack (a genuine legacy duplicate) each keep their OWN bucket now —
  // the earlier `Map<number, FoldAcc>` keyed by pack alone let the SECOND same-pack line silently
  // overwrite the first (`.set(ownPack, ...)`), and the caller's replaceAll then DELETES the
  // first line outright since it never made it into the output — lost goods, not just a
  // double-count. An incoming scan matching a resolved pack folds into the FIRST bucket at that
  // pack in display order (`Array.prototype.find`'s own semantics — SA-103/104's rule); a scan
  // matching NEITHER pack in the list refuses, naming every pack present.
  const bucketsByProduct = new Map<string, FoldAcc[]>();
  // Unlisted lines (no productId) can't be keyed by product — pass them
  // through as their own line items so a merge never drops them.
  const unlisted: Array<{ name?: string; qty: number; unitPrice: number; notes?: string }> = [];

  const bucketsFor = (productId: string) => {
    let list = bucketsByProduct.get(productId);
    if (!list) {
      list = [];
      bucketsByProduct.set(productId, list);
    }
    return list;
  };

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
    const ownPack = deriveUnitsPerBox(li);
    bucketsFor(li.productId).push({
      boxes: hasBoxData ? Number(li.boxes ?? 0) : 0,
      // A plain (box-unaware) line's whole qty folds in as loose pieces.
      pieces: hasBoxData ? Number(li.pieces ?? 0) : Number(li.qty ?? 0),
      unitsPerBox: ownPack,
      boxAware: hasBoxData,
      hadExisting: true,
      existingBoxAware: hasBoxData,
      sourceLineId: li.id ?? undefined,
      trio: {
        trackedCategoryId: li.trackedCategoryId ?? null,
        categoryTaxType: li.categoryTaxType,
        categoryTaxRate: li.categoryTaxRate,
        categoryPriceIncludesTax: li.categoryPriceIncludesTax,
      },
      unitPrice: li.unitPrice != null ? Number(li.unitPrice) : undefined,
      existingPriceType: li.priceType ?? null,
      notes: li.notes ?? null,
      overrideReason: li.overrideReason ?? null,
    });
  }

  // R11/B465 fold-in shared by every "fold this incoming item into an existing bucket" branch
  // below — the accumulator mutation itself never depended on how many OTHER buckets exist.
  const foldInto = (acc: FoldAcc, item: MergeIncomingItem, incomingHasBoxData: boolean) => {
    const incomingUnitsPerBox = deriveUnitsPerBox(item);
    acc.boxes += incomingHasBoxData ? Number(item.boxes ?? 0) : 0;
    acc.pieces += incomingHasBoxData ? Number(item.pieces ?? 0) : Number(item.qty ?? 0);
    if (incomingHasBoxData) acc.boxAware = true;
    if (acc.unitsPerBox <= 1 && incomingUnitsPerBox > 1) acc.unitsPerBox = incomingUnitsPerBox;
    // R11: the EXISTING line's price/note win — a merge never overwrites an
    // operator's override with the client's freshly-resolved catalog price.
    // Incoming values only FILL what the existing line doesn't carry (and are
    // the only source for a brand-new merged line, handled above).
    if (acc.unitPrice == null && item.unitPrice != null) {
      acc.unitPrice = item.unitPrice;
      // #2696(c): the reason travels with the price it justifies (the filled-in one).
      if (item.overrideReason) acc.overrideReason = item.overrideReason;
    }
    if (!acc.notes && item.notes) acc.notes = item.notes;
  };

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
    // B297 row 340: only the buckets whose own trio equals the trio a new sale of this product would take
    // today are fold candidates (`foldTarget`); a differing existing line keeps its own units and trio and the
    // incoming quantity opens a new live-stamped bucket. With no live trio supplied every bucket is a candidate.
    const live = liveTrioByProductId.get(item.productId);
    const allBuckets = bucketsByProduct.get(item.productId);
    const buckets =
      live && allBuckets
        ? allBuckets.filter((b) => b.trio === undefined || foldTarget(b.trio, live) === "ADD")
        : allBuckets;

    if (!buckets || buckets.length === 0) {
      // Brand-new line for this merge — no existing accumulator to fold into.
      bucketsFor(item.productId).push({
        boxes: incomingHasBoxData ? Number(item.boxes ?? 0) : 0,
        pieces: incomingHasBoxData ? Number(item.pieces ?? 0) : Number(item.qty ?? 0),
        unitsPerBox: incomingUnitsPerBox,
        boxAware: incomingHasBoxData,
        hadExisting: false,
        existingBoxAware: false,
        unitPrice: item.unitPrice,
        // #2696(c) SA-558d: a new line is a staff create — its reason rides with its price.
        ...(item.unitPrice != null && item.overrideReason
          ? { overrideReason: item.overrideReason }
          : {}),
        notes: item.notes ?? null,
      });
      continue;
    }

    if (buckets.length === 1) {
      // The common case, unaffected by pack-keying: exactly one existing bucket for this
      // product — fold in exactly as before (agree, fill-in-if-unresolved, or a same-bucket
      // disagreement, which still refuses below).
      const acc = buckets[0];
      if (
        acc.unitsPerBox > 1 &&
        incomingUnitsPerBox > 1 &&
        acc.unitsPerBox !== incomingUnitsPerBox
      ) {
        // B776 (SA-101(1)(d)): the accumulator's pack and this incoming item's OWN pack are
        // both KNOWN and DISAGREE — refuse the whole fold rather than silently combining
        // pieces priced under two different box sizes into one re-split line. Never
        // re-denominates the other lines in the same payload; the caller (a single
        // interactive request) simply retries.
        throw new ConflictException({
          code: API_ERROR_CODES.MERGE_PACK_MISMATCH,
          message: `Product ${item.productId} is on this order at a ${acc.unitsPerBox}-pack and the scanned item is a ${incomingUnitsPerBox}-pack — resolve the mismatch before merging.`,
          productId: item.productId,
          existingPacks: [acc.unitsPerBox],
          incomingPack: incomingUnitsPerBox,
        });
      }
      foldInto(acc, item, incomingHasBoxData);
      continue;
    }

    // SA-124g/h/i R1: 2+ existing buckets for this product (either a durable split from an
    // earlier pack-mismatch sweep, or a genuine same-pack/plain-product duplicate). A scan
    // whose own pack matches one of them folds into the FIRST such bucket in display order
    // (`.find`'s own semantics), the other(s) untouched byte-identical — never summed across
    // duplicates. Otherwise: if ANY bucket carries a known pack (> 1), the incoming item's own
    // known pack matches none of them — refuse (SA-124i: a SINGLE known-pack bucket beside a
    // plain one is still a genuine disagreement, not the "all buckets plain" shape below; the
    // original R1 cut required 2+ DISTINCT known packs, which silently let a boxed bucket's
    // pack lose to a mismatched scan whenever only ONE bucket was boxed). Folding into the
    // FIRST bucket instead is reserved for the case NO bucket has any known pack at all
    // (plain-product duplicates) — refusing wrongly there costs a broken auto-merge/cart-submit
    // for the overwhelming majority of products, which are not boxed at all (Opus's HIGH
    // finding, R1's original scope).
    if (incomingUnitsPerBox > 1) {
      const acc = buckets.find((b) => b.unitsPerBox === incomingUnitsPerBox);
      if (acc) {
        foldInto(acc, item, incomingHasBoxData);
        continue;
      }
      const knownPacks = [...new Set(buckets.map((b) => b.unitsPerBox).filter((p) => p > 1))].sort(
        (a, b) => a - b,
      );
      if (knownPacks.length >= 1) {
        throw new ConflictException({
          code: API_ERROR_CODES.MERGE_PACK_MISMATCH,
          message: `Product ${item.productId} is on this order at packs [${knownPacks.join(", ")}] and the scanned item is a ${incomingUnitsPerBox}-pack — resolve the mismatch before merging.`,
          productId: item.productId,
          existingPacks: knownPacks,
          incomingPack: incomingUnitsPerBox,
        });
      }
    }
    foldInto(buckets[0], item, incomingHasBoxData);
  }

  const merged: Array<Record<string, unknown>> = [];
  const livePackFallbackProductIds: string[] = [];
  for (const [productId, buckets] of bucketsByProduct.entries()) {
    const livePack = liveUnitsPerBoxByProductId.get(productId) ?? 0;
    for (const acc of buckets) {
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
        // Box data with no resolvable box size. NEVER drop the boxes (that is the
        // silent-loss bug): hand the raw split down so updateOrderItems re-derives the
        // canonical split + qty from the LIVE product (SA-124's live-pack fallback,
        // surfaced below for the caller to warn).
        boxes = acc.boxes;
        pieces = acc.pieces;
        livePackFallbackProductIds.push(productId);
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
      // SA-124e(3): a bucket resolved at a DIFFERENT pack than the product's CURRENT live pack
      // carries a price that IS the price for that pack (a 12-pack line's $36/box is correct
      // at pack 12 even after the product becomes a 6-pack) — never re-derived from the live
      // catalog, which prices at the LIVE pack. Re-derivation (R0's original rule) still
      // applies only when this bucket's own pack MATCHES the live pack, or when there is no
      // live-pack info supplied at all (unchanged legacy behavior for a caller that omits it).
      const packDiffersFromLive =
        acc.unitsPerBox > 1 && livePack > 1 && acc.unitsPerBox !== livePack;
      const overrideOk =
        !acc.hadExisting || acc.existingPriceType === "MANUAL" || packDiffersFromLive;
      const priceSurvives = denominationOk && overrideOk;
      merged.push({
        productId,
        qty,
        ...(boxes != null ? { boxes } : {}),
        ...(pieces != null ? { pieces } : {}),
        // SA-124e(1): the bucket's own resolved pack rides along so a replace-all rebuild can
        // recreate this line at the pack it was ACTUALLY priced at, never the live product row.
        ...(acc.unitsPerBox > 1 ? { unitsPerBox: acc.unitsPerBox } : {}),
        // SA-124f: the specific existing line this bucket came from (none for a brand-new
        // line) — the rebuild compares/preserves price by THIS id, never by productId alone.
        ...(acc.sourceLineId ? { sourceLineId: acc.sourceLineId } : {}),
        ...(acc.unitPrice != null && priceSurvives ? { unitPrice: acc.unitPrice } : {}),
        // B465: the reason travels with the price it justifies — never survives
        // when the price itself doesn't (a re-derived line has nothing to
        // document), never fabricated when the price does (only a genuine
        // stored MANUAL reason is carried, not synthesized here).
        ...(acc.overrideReason && priceSurvives ? { overrideReason: acc.overrideReason } : {}),
        ...(acc.notes ? { notes: acc.notes } : {}),
      });
    }
  }

  return { items: [...merged, ...unlisted], livePackFallbackProductIds };
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
