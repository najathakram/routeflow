import { PriceType } from "@prisma/client";
import { assertSafeTextCell } from "../common/safe-text-cell";
import { resolveBuyerLinePrice } from "./buyer-merge-pricing";
import type { PromotionRule } from "@routeflow/pricing";
import type { SplitPromoGroup } from "./split-promo-group";

/**
 * Row 497 (SA ruling, option B): a buyer's FULL-LIST replace of PACK lines (updateOrderItems, CUSTOMER branch)
 * recreates every line, and used to re-price each one at the buyer's current tier, so an operator override on a
 * line the buyer left alone was lost. `keptOverrideFor` is the one answer to "does this entry keep its stored
 * price": only an UNCHANGED line (same product, same unit, paired to its stored line by the one pairing helper)
 * that carries an OVERRIDE keeps unitPrice / priceType / originalPrice / overrideReason / overriddenBy. A PLAIN
 * tier line (STANDARD, SPECIAL without a reason, PROMO) re-prices at the current tier (SA-507b, exactly as the
 * unit buyer diff does in `buildUnitLine`), and a new line or a changed product / unit prices fresh.
 * The subtotal is NOT decided here: the caller feeds the kept price through `computeLineSubtotal`, so a boxed
 * line is prorated by box and a changed quantity is recomputed (never `qty * unitPrice`).
 */

/** The columns of a LOCKED stored line this rule reads (all in the diff branch's held-line select). */
export interface HeldPriceLine {
  productId?: string | null;
  unitLabel?: string | null;
  status?: string | null;
  unitPrice?: unknown;
  priceType?: string | null;
  originalPrice?: unknown;
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

export interface KeptOverride {
  /** Shaped like `resolveBuyerLinePrice`'s answer: a kept line never earns free units. */
  price: {
    unitPrice: number;
    originalPrice: number | null;
    priceType: PriceType;
    freeUnits: number;
  };
  /** Spread into the line's create data. */
  stamp: { overrideReason: string | null; overriddenBy: string | null };
}

/** An operator's decision on the line: DISCOUNTED / MANUAL, or SPECIAL with a reason on file. */
export const isStoredOverride = (l: Pick<HeldPriceLine, "priceType" | "overrideReason">): boolean =>
  l.priceType === PriceType.DISCOUNTED ||
  l.priceType === PriceType.MANUAL ||
  (l.priceType === PriceType.SPECIAL && !!l.overrideReason?.trim());

/**
 * `item.sourceLineId` is set by the pairing helper (`pairEditLines`, or the buyer cart fold); `held` is the
 * order's lines read UNDER the row lock. Null for everything that is not an unchanged stored override.
 */
export function keptOverrideFor(
  item: { productId?: string | null; sourceLineId?: string; unitLabel?: string | null },
  held: ReadonlyMap<string, HeldPriceLine>,
): KeptOverride | null {
  const own = item.sourceLineId ? held.get(item.sourceLineId) : undefined;
  if (!own || own.status === "CANCELLED" || own.unitPrice == null) return null;
  if (own.productId !== item.productId) return null; // a changed product is a new sale
  if ((own.unitLabel ?? null) !== null || (item.unitLabel ?? null) !== null) return null; // pack lines only
  if (!isStoredOverride(own)) return null;
  return {
    price: {
      unitPrice: Number(own.unitPrice),
      originalPrice: own.originalPrice == null ? null : Number(own.originalPrice),
      priceType: own.priceType as PriceType,
      freeUnits: 0,
    },
    stamp: { overrideReason: own.overrideReason ?? null, overriddenBy: own.overriddenBy ?? null },
  };
}

/**
 * Row 496: a typed `overrideReason` is printed on exports, so one a spreadsheet would run as a formula is
 * refused 400 TEXT_CELL_FORMULA_LEAD before any write. Change-only (assertSafeTextCell's rule): a reason that
 * merely echoes the stored line's own never blocks an unrelated edit.
 */
export function assertSafeOverrideReasons(
  items: ReadonlyArray<{ id?: string; overrideReason?: string | null }>,
  stored: ReadonlyArray<{ id: string; overrideReason?: string | null }>,
): void {
  const byId = new Map(stored.map((l) => [l.id, l]));
  for (const it of items) {
    assertSafeTextCell(
      { overrideReason: it.overrideReason },
      it.id ? { overrideReason: byId.get(it.id)?.overrideReason } : null,
    );
  }
}

/**
 * The price (and, for a kept override, the stamp) of one line of a replace-all payload. A BUYER's line takes its
 * tier price plus the best promotion, unless it is an unchanged stored override (`keptOverrideFor`); anyone
 * else (the driver) keeps the legacy list price. A split-promo `group` shares one product's promotion across its lines.
 */
export function priceReplacedLine(a: {
  product: { id: string; category: string | null; pricePerUnit: unknown };
  item: { productId: string; sourceLineId?: string };
  held: ReadonlyMap<string, HeldPriceLine>;
  isBuyerEdit: boolean;
  group: SplitPromoGroup | undefined;
  tier: number;
  buyerPromos: PromotionRule[];
  qtyPieces: number;
  qtyUnits: number;
  lastPrice: number | null;
  denomination: { boxes: number | null; pieces: number | null; unitsPerBox: number };
}): {
  priced: KeptOverride["price"];
  stamp?: KeptOverride["stamp"];
} {
  const kept = a.isBuyerEdit ? keptOverrideFor(a.item, a.held) : null;
  if (kept) return { priced: kept.price, stamp: kept.stamp };
  const raw = a.isBuyerEdit
    ? resolveBuyerLinePrice(
        a.product,
        a.tier,
        a.buyerPromos,
        a.group?.qtyPieces ?? a.qtyPieces,
        a.group?.qtyUnits ?? a.qtyUnits,
        a.lastPrice,
        // REG-B109: the exact denomination this line bills with.
        a.group?.denomination ?? a.denomination,
      )
    : {
        unitPrice: Number(a.product.pricePerUnit),
        originalPrice: null as number | null,
        priceType: PriceType.STANDARD,
        freeUnits: 0,
      };
  return {
    priced: a.group ? { ...raw, freeUnits: a.group.share(a.item, raw.freeUnits) } : raw,
  };
}
