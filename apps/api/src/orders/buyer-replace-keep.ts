import { PriceType } from "@prisma/client";
import type { CustomerLayerPrice } from "@routeflow/pricing";
import { assertSafeTextCell } from "../common/safe-text-cell";
import { resolveBuyerLinePrice } from "./buyer-merge-pricing";
import type { PromotionRule } from "@routeflow/pricing";
import { planSplitPromos, type SplitPromoGroup } from "./split-promo-group";

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
  /** The sale-time box size snapshot on a box-split line; null on a box-unaware (selling-unit) line. */
  unitsPerBox?: unknown;
  /** Set on a box-split line. With no `unitsPerBox` snapshot it is a legacy row whose box size is unknown. */
  boxes?: unknown;
  status?: string | null;
  /** The stored quantity: a driver's kept line keeps its free units only when this quantity is unchanged. */
  qty?: unknown;
  /** The sale-time BUY_N_GET_M free units the stored line earned. */
  promoFreeUnits?: unknown;
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

const freeUnitsOf = (l: Pick<HeldPriceLine, "promoFreeUnits">): number =>
  Math.max(0, Number(l.promoFreeUnits ?? 0));

/**
 * `item.sourceLineId` is set by the pairing helper (`pairEditLines`, or the buyer cart fold); `held` is the
 * order's lines read UNDER the row lock. Null for everything that is not an unchanged stored override.
 */
export function keptOverrideFor(
  item: { productId?: string | null; sourceLineId?: string; unitLabel?: string | null },
  held: ReadonlyMap<string, HeldPriceLine>,
  /** The product's LIVE box size: the replace re-splits at it (see below). */
  liveUnitsPerBox?: unknown,
  /**
   * B1036 (ruling 2026-10-03, forward-only), a DRIVER's full list only: its NEW quantity. A driver's re-listed line keeps
   * its stored price whatever the price type (a tier line too, not just an override), and its free units while the quantity is unchanged.
   */
  driverQty?: number,
): KeptOverride | null {
  const own = item.sourceLineId ? held.get(item.sourceLineId) : undefined;
  if (!own || own.status === "CANCELLED" || own.unitPrice == null) return null;
  if (own.productId !== item.productId) return null; // a changed product is a new sale
  if ((own.unitLabel ?? null) !== null || (item.unitLabel ?? null) !== null) return null; // pack lines only
  if (driverQty === undefined && !isStoredOverride(own)) return null;
  // The kept price is per BOX, and the replace re-splits the quantity at the LIVE box size. A line sold in
  // boxes of 12 whose product is now boxes of 6 would bill 2 x $36 as 4 x $36, so it prices fresh instead.
  // Fail closed: a legacy box-split row has no snapshot of the box size its price was set at.
  if (own.boxes != null && own.unitsPerBox == null) return null;
  if (own.unitsPerBox != null && Number(own.unitsPerBox) !== Number(liveUnitsPerBox ?? 0))
    return null;
  return {
    price: {
      unitPrice: Number(own.unitPrice),
      originalPrice: own.originalPrice == null ? null : Number(own.originalPrice),
      priceType: own.priceType as PriceType,
      freeUnits: driverQty !== undefined && Number(own.qty) === driverQty ? freeUnitsOf(own) : 0,
    },
    stamp: { overrideReason: own.overrideReason ?? null, overriddenBy: own.overriddenBy ?? null },
  };
}

/**
 * The entries of a replace payload that price at the tier (not kept). A kept override never combines with a
 * promotion, so it must stay OUT of `planSplitPromos`: left in, it takes the oldest line's share of a product's
 * free units and returns without ever asking for it, and the units vanish.
 */
export function dropKeptOverrides<T extends { productId?: string | null; sourceLineId?: string }>(
  items: ReadonlyArray<T>,
  held: ReadonlyMap<string, HeldPriceLine>,
  productMap: ReadonlyMap<string, { unitsPerBox?: unknown }>,
): T[] {
  return items.filter(
    (i) => !keptOverrideFor(i, held, i.productId ? productMap.get(i.productId)?.unitsPerBox : null),
  );
}

/** `planSplitPromos` over the entries that price at the tier (see `dropKeptOverrides`). */
export function planPromos(
  items: ReadonlyArray<{ productId?: string | null; sourceLineId?: string; qty?: number }>,
  held: ReadonlyMap<string, HeldPriceLine>,
  lineItems: Parameters<typeof planSplitPromos>[1] | undefined,
  productMap: ReadonlyMap<string, { unitsPerBox?: unknown }>,
  pieceDenominated: ReadonlySet<string>,
) {
  return planSplitPromos(
    dropKeptOverrides(items, held, productMap),
    lineItems ?? [],
    productMap,
    pieceDenominated,
  );
}

/**
 * Row 496: a typed `overrideReason` is printed on exports, so one a spreadsheet would run as a formula is
 * refused 400 TEXT_CELL_FORMULA_LEAD before any write. Change-only (assertSafeTextCell's rule): a reason that
 * merely echoes the stored line's own never blocks an unrelated edit.
 */
export function assertSafeOverrideReasons(
  items: ReadonlyArray<{
    id?: string;
    /** A fold entry names its stored line this way; the buyer's items edit by `orderItemId`. */
    sourceLineId?: string;
    orderItemId?: string;
    overrideReason?: string | null;
  }>,
  stored: ReadonlyArray<{ id: string; overrideReason?: string | null }>,
): void {
  const byId = new Map(stored.map((l) => [l.id, l]));
  for (const it of items) {
    const own = byId.get(it.id ?? it.sourceLineId ?? it.orderItemId ?? "");
    assertSafeTextCell(
      {
        overrideReason:
          typeof it.overrideReason === "string" ? it.overrideReason.trim() : undefined,
      },
      {
        overrideReason:
          typeof own?.overrideReason === "string" ? own.overrideReason.trim() : undefined,
      },
    );
  }
}

/**
 * The price (and, for a kept override, the stamp) of one line of a replace-all payload. A BUYER's line takes its
 * tier price plus the best promotion, unless it is an unchanged stored override (`keptOverrideFor`). A DRIVER's
 * (B1036) takes the same tier chain, but a line already on the order keeps its stored price (`keptOverrideFor`'s `driverQty`).
 * Anyone else keeps the list price. A split-promo `group` shares one product's promotion across its lines.
 */
export function priceReplacedLine(a: {
  product: { id: string; category: string | null; pricePerUnit: unknown; unitsPerBox?: unknown };
  item: { productId: string; sourceLineId?: string };
  held: ReadonlyMap<string, HeldPriceLine>;
  isBuyerEdit: boolean;
  /** B1036: a DRIVER's full list. Resolves the same tier chain as the buyer's, but keeps a re-listed line's stored price. */
  isDriverEdit?: boolean;
  /** The line's stored quantity (pieces when re-split): a kept line's free units survive only an unchanged one. */
  qty?: number;
  group: SplitPromoGroup | undefined;
  tier: number;
  /** S19, flag.units_prices_v2 only: the pack's customer-layer price (above sticky history and the tier price). */
  layer?: CustomerLayerPrice | null;
  buyerPromos: PromotionRule[];
  qtyPieces: number;
  qtyUnits: number;
  lastPrice: number | null;
  denomination: { boxes: number | null; pieces: number | null; unitsPerBox: number };
}): {
  priced: KeptOverride["price"];
  stamp?: KeptOverride["stamp"];
} {
  const driverQty = a.isDriverEdit && !a.isBuyerEdit ? (a.qty ?? 0) : undefined;
  const kept =
    a.isBuyerEdit || a.isDriverEdit
      ? keptOverrideFor(a.item, a.held, a.product.unitsPerBox, driverQty)
      : null;
  if (kept) return { priced: kept.price, stamp: kept.stamp };
  const atTier = a.isBuyerEdit || !!a.isDriverEdit;
  const raw = atTier
    ? resolveBuyerLinePrice(
        a.product,
        a.tier,
        a.buyerPromos,
        a.group?.qtyPieces ?? a.qtyPieces,
        a.group?.qtyUnits ?? a.qtyUnits,
        a.lastPrice,
        // REG-B109: the exact denomination this line bills with.
        a.group?.denomination ?? a.denomination,
        a.layer,
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
