/**
 * B776 (CRITICAL, SA-101(1)) — shared catalog-line write planning for `mergeAllPendingForCustomer`
 * and `forceConsolidateCustomer`. Replaces each method's own "bump the winner's overlapping line,
 * then create a line for every loser-only product" pair of loops: both now build PER-PRODUCT
 * PACK GROUPS first (`merge-pack-resolve.ts`) and emit one write PER GROUP, so a product whose
 * contributing lines disagree on pack never folds across that disagreement.
 */
import { PriceType } from "@prisma/client";
import {
  copyCategoryTaxSnapshot,
  type CategoryTaxType,
  type PromotionRule,
} from "@routeflow/pricing";
import { mergeBoxedContributions } from "./buyer-merge-pricing";
import { groupContributionsByPack, type PackCandidate } from "./merge-pack-resolve";
import { compositionStampOf } from "./order-composition";

export { compositionStampOf };

export interface MergeLine extends PackCandidate {
  /** Set only on the winner's own existing OrderItem row — identity distinguishes it in a group. */
  id?: string;
  productId: string | null;
  unitPrice: unknown;
  subtotal: unknown;
  priceType: PriceType;
  originalPrice: unknown;
  overrideReason: string | null;
  overriddenBy: string | null;
  notes: string | null;
  promoFreeUnits: unknown;
  trackedCategoryId: string | null;
  /** B297 (SA-098a) — a Prisma `Decimal` at the real callsite (like `unitPrice`); coerced at use. */
  categoryTaxType: CategoryTaxType | null;
  categoryTaxRate: unknown;
  categoryPriceIncludesTax: boolean | null;
  /** #2717 M3: composition provenance; a FIXED line folds only with the same recipeVersion. */
  compositionMode?: string | null;
  recipeId?: string | null;
  recipeVersion?: number | null;
  /** SA-716: the line's backorder marker (PIECES); a merge CARRIES it, never recomputes it. */
  backorderedPieces?: unknown;
}

export interface MergeLineWriteData {
  productId: string;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  /** SA-101(1)(c): the pack this line was actually priced at — never the live product row. */
  unitsPerBox: number | null;
  unitPrice: number;
  subtotal: number;
  promoFreeUnits: number | null;
  priceType: PriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  notes: string | null;
  trackedCategoryId: string | null;
  /** B297/SA-098a: a new winner line is a new sale — COPIED verbatim from the losing line
   * (`copyCategoryTaxSnapshot` — a merge is not a new sale, never re-derived from the live category). */
  categoryTaxType: CategoryTaxType | null;
  categoryTaxRate: number | null;
  categoryPriceIncludesTax: boolean | null;
  /** #2717 M3: a moved/created FIXED line keeps the recipe stamp it had; absent on plain lines. */
  compositionMode?: string;
  recipeId?: string | null;
  recipeVersion?: number | null;
  /** SA-716: Σ of the folded losing lines' markers; absent (= 0) when none carried one. */
  backorderedPieces?: number;
}

type MergeLineUpdateData = Pick<
  MergeLineWriteData,
  "qty" | "boxes" | "pieces" | "unitsPerBox" | "subtotal"
> & { promoFreeUnits?: number | null; backorderedPieces?: number };

export type MergeLineWrite =
  | { kind: "update"; lineId: string; data: MergeLineUpdateData }
  | { kind: "create"; data: MergeLineWriteData };

export interface MergeWarning {
  /** SA-124: `packMismatch` is a genuine disagreement (packsSeen has 2+ entries); `livePackFallback`
   * is SA-101(a)'s branch-4 last resort (a box-unaware contribution with no snapshot and no split —
   * `packsSeen` here is always the single live pack every such contribution resolved to). The two
   * are independent: a product can emit either, both, or neither. */
  kind: "packMismatch" | "livePackFallback";
  productId: string;
  packs: number[];
}

export interface BuildMergeLineWritesOptions {
  promos: PromotionRule[];
  canEarnNew: boolean;
  categoryFor: (productId: string) => string | null;
  liveUnitsPerBoxFor: (productId: string) => number;
}

/** Fold key: lines of one product fold only at the same composition (FIXED version, or plain). */
const versionKey = (li: MergeLine): string =>
  li.compositionMode === "FIXED" ? `FIXED:${li.recipeVersion ?? ""}` : "";

/** SA-716: the markers of `lines` summed at the column's 3 decimals; the carried value. */
const markerSum = (lines: readonly MergeLine[]): number =>
  Math.round(lines.reduce((sum, li) => sum + (Number(li.backorderedPieces) || 0), 0) * 1000) / 1000;

/** `unitsPerBox` a NON-boxed line ends up written with — matches computeLineSubtotal's own
 * "boxed only when boxes != null" contract: a group whose resolved pack is <= 1 never boxes. */
const packForWrite = (pack: number, boxes: number | null) =>
  boxes != null && pack > 1 ? pack : null;

export function buildMergeLineWrites(
  winnerLines: readonly MergeLine[],
  loserLines: readonly MergeLine[],
  opts: BuildMergeLineWritesOptions,
): { writes: MergeLineWrite[]; warnings: MergeWarning[] } {
  const loserByProduct = new Map<string, MergeLine[]>();
  for (const li of loserLines) {
    if (!li.productId) continue;
    const list = loserByProduct.get(li.productId) ?? [];
    list.push(li);
    loserByProduct.set(li.productId, list);
  }
  // SA-124a: a product may carry MORE THAN ONE winner line — the durable result of an earlier
  // pack-mismatch sweep (two lines, at two packs, both left on the winner order). Collapsing to
  // one-per-product here (the old `Map<string, MergeLine>`, last-write-wins) silently dropped
  // whichever winner line lost the overwrite from every later merge/sweep touching that product.
  const winnerByProduct = new Map<string, MergeLine[]>();
  for (const li of winnerLines) {
    if (!li.productId) continue;
    const list = winnerByProduct.get(li.productId) ?? [];
    list.push(li);
    winnerByProduct.set(li.productId, list);
  }
  const productIds = new Set<string>([...winnerByProduct.keys(), ...loserByProduct.keys()]);

  const writes: MergeLineWrite[] = [];
  const warnings: MergeWarning[] = [];

  // #2717 M3 (C9a/C9b): split every product's contributions by composition first, so a FIXED line
  // never folds across a recipe version (or with a plain line). One bucket per product otherwise.
  const buckets: Array<{ productId: string; winner: MergeLine[]; losers: MergeLine[] }> = [];
  for (const productId of productIds) {
    const w = winnerByProduct.get(productId) ?? [];
    const l = loserByProduct.get(productId) ?? [];
    const keys = new Set([...w, ...l].map(versionKey));
    if (keys.size <= 1) buckets.push({ productId, winner: w, losers: l });
    else {
      for (const k of keys) {
        buckets.push({
          productId,
          winner: w.filter((li) => versionKey(li) === k),
          losers: l.filter((li) => versionKey(li) === k),
        });
      }
    }
  }

  for (const { productId, winner: winnerLinesForProduct, losers } of buckets) {
    if (losers.length === 0) continue; // nothing contributed by any loser — every winner line is untouched.

    const liveUpb = opts.liveUnitsPerBoxFor(productId);
    const { groups, disagreement, packsSeen, usedLivePack } = groupContributionsByPack(
      winnerLinesForProduct,
      losers,
      liveUpb,
    );
    if (disagreement) warnings.push({ kind: "packMismatch", productId, packs: packsSeen });
    // SA-124: the live-pack fallback (SA-101(a) branch 4) was computed but silently dropped —
    // a box-unaware contribution with no snapshot and no split resolves at the LIVE product
    // pack, which can drift from what the line was actually priced at. Independent of
    // `disagreement` — a product can fall back to the live pack with or without also disagreeing.
    if (usedLivePack) warnings.push({ kind: "livePackFallback", productId, packs: [liveUpb] });

    // SA-124c: a SECOND winner line can land in the same group as the primary (a legacy
    // same-product duplicate at the same pack, or a diff-add) — it must never be folded into
    // the primary's update (that double-counts it: its own row survives untouched AND its
    // qty gets summed into the primary). Only LOSER contributions are ever fold candidates.
    const winnerSet = new Set(winnerLinesForProduct);

    for (const group of groups) {
      const losersInGroup = group.contributions.filter((c) => !winnerSet.has(c));
      if (losersInGroup.length === 0) continue; // nothing to fold — every line in this group, winner or not, is untouched.

      if (group.isSingleMove) {
        const c = group.contributions[0];
        writes.push({
          kind: "create",
          data: {
            productId,
            qty: Number(c.qty),
            boxes: c.boxes,
            pieces: c.pieces,
            unitsPerBox: packForWrite(group.pack, c.boxes),
            unitPrice: Number(c.unitPrice),
            subtotal: Number(c.subtotal),
            promoFreeUnits: c.promoFreeUnits != null ? Number(c.promoFreeUnits) : null,
            priceType: c.priceType,
            originalPrice: c.originalPrice != null ? Number(c.originalPrice) : null,
            overrideReason: c.overrideReason,
            overriddenBy: c.overriddenBy,
            notes: c.notes,
            trackedCategoryId: c.trackedCategoryId ?? null,
            ...copyCategoryTaxSnapshot({
              categoryTaxType: c.categoryTaxType,
              categoryTaxRate: c.categoryTaxRate as number | string | null,
              categoryPriceIncludesTax: c.categoryPriceIncludesTax,
            }),
            ...compositionStampOf(c),
            ...(markerSum([c]) > 0 ? { backorderedPieces: markerSum([c]) } : {}),
          },
        });
        continue;
      }

      const primary = group.winnerInGroup ?? losersInGroup[0];
      // SA-124c: LOSERS only — a second winner line at this same pack (already excluded from
      // losersInGroup) stays out of the fold entirely, never summed into the primary.
      const others = losersInGroup.filter((c) => c !== primary);
      const merged = mergeBoxedContributions(
        [primary, ...others].map((c) => ({
          qty: c.qty,
          boxes: c.boxes,
          pieces: c.pieces,
          promoFreeUnits: c.promoFreeUnits != null ? Number(c.promoFreeUnits) : null,
          priceType: c.priceType,
          overriddenBy: c.overriddenBy,
        })),
        Number(primary.unitPrice),
        group.pack,
        {
          promos: opts.promos,
          productId,
          category: opts.categoryFor(productId),
          canEarnNew: opts.canEarnNew,
          pricePromoApplied: primary.priceType === PriceType.PROMO && primary.originalPrice != null,
        },
      );
      const unitsPerBox = packForWrite(group.pack, merged.boxes);

      if (group.isWinnerGroup) {
        writes.push({
          kind: "update",
          lineId: group.winnerInGroup!.id!,
          data: {
            qty: merged.qty,
            boxes: merged.boxes,
            pieces: merged.pieces,
            unitsPerBox,
            subtotal: merged.subtotal,
            // Untouched (key omitted, not re-written) when no contribution ever carried a
            // free-unit snapshot — mirrors the pre-fix conditional spread exactly.
            ...(merged.freeUnits > 0 || merged.storedFreeUnits > 0
              ? { promoFreeUnits: merged.freeUnits > 0 ? merged.freeUnits : null }
              : {}),
            // SA-716: the winner line keeps its own marker and takes the folded losers' on top.
            ...(markerSum(losersInGroup) > 0
              ? { backorderedPieces: markerSum([group.winnerInGroup!, ...losersInGroup]) }
              : {}),
          },
        });
      } else {
        writes.push({
          kind: "create",
          data: {
            productId,
            qty: merged.qty,
            boxes: merged.boxes,
            pieces: merged.pieces,
            unitsPerBox,
            unitPrice: Number(primary.unitPrice),
            subtotal: merged.subtotal,
            promoFreeUnits: merged.freeUnits > 0 ? merged.freeUnits : null,
            priceType: primary.priceType,
            originalPrice: primary.originalPrice != null ? Number(primary.originalPrice) : null,
            overrideReason: primary.overrideReason,
            overriddenBy: primary.overriddenBy,
            notes: primary.notes,
            trackedCategoryId: primary.trackedCategoryId ?? null,
            ...copyCategoryTaxSnapshot({
              categoryTaxType: primary.categoryTaxType,
              categoryTaxRate: primary.categoryTaxRate as number | string | null,
              categoryPriceIncludesTax: primary.categoryPriceIncludesTax,
            }),
            ...compositionStampOf(primary),
            ...(markerSum(losersInGroup) > 0
              ? { backorderedPieces: markerSum(losersInGroup) }
              : {}),
          },
        });
      }
    }
  }

  return { writes, warnings };
}
