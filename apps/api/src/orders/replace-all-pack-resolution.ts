/**
 * SA-124e — how `updateOrderItems`' replace-all branch resolves the pack (`unitsPerBox`) for a
 * line it is about to delete and recreate. Adapts B717/SA-077's rule (already applied to
 * `InvoicesService.update()`'s own replace path, `invoices/update-pack-resolution.ts`) to the
 * ORDER side, which never had it: the replace-all rebuild (`orders.service.ts`'s `replaceAll`
 * branch) unconditionally re-split every boxed item against the LIVE product pack
 * (`normalizeBoxesPieces({ ..., unitsPerBox: product.unitsPerBox })`), so a pack-keyed fold
 * (SA-124a/SA-124c) still ended in a live re-split: a 12-pack bucket's 1 box became 6 pieces at
 * a live pack of 6, and its non-MANUAL price was dropped and re-derived from the live catalog —
 * a box-of-6 price silently applied to a 12-pack line.
 *
 * THE ORDER (SA-077's rule, same as the invoice side): the payload's own pack (an explicit
 * `unitsPerBox` — `foldMergeItems`'s own bucket-pack output, SA-124e(1) — or derived from the
 * payload's own boxes/pieces/qty split), then the SOLE surviving pre-edit line of the SAME
 * product when the pairing is unambiguous (exactly one — the same discipline this file's
 * `bogoCounterparts`/`existingLineByProduct` already use, never "some of several agree"), then
 * the live product pack with a warn. A split that still resolves to nothing on a product whose
 * pre-edit state had 2+ DISTINCT real packs REFUSES (MERGE_PACK_MISMATCH, naming those packs)
 * rather than defaulting to the live pack or silently storing an unboxed line — the live default
 * is exactly the bug this module exists to close, so it is never the fallback for a product that
 * demonstrably has more than one pack in play.
 */

import { ConflictException } from "@nestjs/common";
import { packFromOwnSplit } from "@routeflow/pricing";

/** A surviving pre-edit `OrderItem` row, as this module needs it. */
export interface PriorOrderPackRow {
  productId: string | null;
  unitsPerBox: unknown;
}

export interface PriorPackInfo {
  /** The unambiguous pack: set only when exactly one pre-edit line existed for a product AND
   * it carried a real pack (SA-077b's unanimity rule specialized to "exactly one line"). */
  unambiguousPack?: number;
  /** Every DISTINCT real pack seen across ALL pre-edit lines for this product, sorted — for
   * naming a refusal. Empty when no pre-edit line for this product carried a real pack. */
  allPacks: number[];
}

/**
 * One entry per product with at least one pre-edit line, built BEFORE the replace-all's
 * `deleteMany` erases them — same timing requirement as `preEditLinesByProduct`/
 * `bogoCounterparts`/`existingLineByProduct` in `orders.service.ts`, which this reuses the
 * pattern from rather than duplicating a second pre-edit scan.
 */
export function buildPriorOrderPackInfo(lines: PriorOrderPackRow[]): Map<string, PriorPackInfo> {
  const seen = new Map<string, number[]>();
  for (const li of lines) {
    if (!li.productId) continue;
    const pack = Number(li.unitsPerBox ?? 0);
    const list = seen.get(li.productId) ?? [];
    list.push(pack);
    seen.set(li.productId, list);
  }
  const info = new Map<string, PriorPackInfo>();
  for (const [productId, packs] of seen) {
    const allPacks = [...new Set(packs.filter((p) => p > 1))].sort((a, b) => a - b);
    info.set(productId, {
      unambiguousPack: packs.length === 1 && packs[0] > 1 ? packs[0] : undefined,
      allPacks,
    });
  }
  return info;
}

export interface ResolvedReplaceAllPack {
  /** The pack to price and split with; undefined leaves the line unboxed (a genuinely
   * never-boxed product, or a box-unaware payload item with nothing to resolve). */
  pack?: number;
  /** True only when the live product pack was the ONLY resolvable source — SA-124's
   * livePackFallback signal, for the caller to warn (mirrors the sweep/fold paths' same flag). */
  usedLivePack: boolean;
}

/**
 * The order in this module's header, for ONE replace-all payload item. Throws
 * `ConflictException` (MERGE_PACK_MISMATCH, matching `foldMergeItems`'s own shape) rather than
 * ever defaulting a demonstrably multi-pack product to the live pack or an unboxed line.
 */
export function resolveReplaceAllLinePack(
  item: {
    productId?: string | null;
    boxes?: number | null;
    pieces?: number | null;
    qty?: number;
    unitsPerBox?: number | null;
  },
  priorPacks: Map<string, PriorPackInfo>,
  livePack: number,
): ResolvedReplaceAllPack {
  const hasBoxData = (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;

  // (a) the payload's own pack — an explicit unitsPerBox (foldMergeItems's own bucket-pack
  // output, SA-124e(1)) takes precedence over re-deriving the same fact from the split.
  if (item.unitsPerBox != null && item.unitsPerBox > 1) {
    return { pack: item.unitsPerBox, usedLivePack: false };
  }
  const ownSplitPack = packFromOwnSplit({
    qty: item.qty ?? 0,
    boxes: item.boxes,
    pieces: item.pieces,
  });
  if (ownSplitPack != null) return { pack: ownSplitPack, usedLivePack: false };

  const info = item.productId ? priorPacks.get(item.productId) : undefined;

  // (b) the stored line's snapshot for the SAME product, when the pre-edit pairing was
  // unambiguous (exactly one pre-edit line, and it carried a real pack).
  if (info?.unambiguousPack != null) {
    return { pack: info.unambiguousPack, usedLivePack: false };
  }

  if (!hasBoxData) {
    // A genuinely bare-qty payload item with NO resolvable pack anywhere stays box-unaware —
    // unchanged legacy behavior for a product that was never boxed (or whose pre-edit state
    // is ambiguous with no split of its own to resolve it either).
    return { usedLivePack: false };
  }

  // The item carries box data but no pack resolved from (a) or (b) (the bare-qty case, where
  // the snapshot wins, already returned above at (b) or the box-unaware branch just above).
  // A product whose pre-edit state demonstrably had 2+ DISTINCT real packs is NEVER defaulted
  // to the live pack here — that default is exactly SA-124e's bug. Refuse instead, naming
  // every pre-edit pack, so the caller resolves the mismatch rather than silently re-splitting
  // at a pack that may match neither of the order's actual lines.
  if (info && info.allPacks.length > 1) {
    throw new ConflictException({
      code: "MERGE_PACK_MISMATCH",
      message: `Product ${item.productId} is on this order at packs [${info.allPacks.join(", ")}] and the replace-all payload's split does not resolve a pack — resolve the mismatch before saving.`,
      productId: item.productId,
      existingPacks: info.allPacks,
      incomingPack: null,
    });
  }

  // (c) the live product pack, with a warn — the last resort, only for a product that never
  // demonstrated more than one real pack pre-edit.
  if (livePack > 1) return { pack: livePack, usedLivePack: true };

  return { usedLivePack: false };
}
