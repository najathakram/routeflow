/**
 * Buyer-line pricing and boxed-merge helpers — lifted VERBATIM out of `OrdersService` (B585
 * prefactor #2: `orders.service.ts` sits at its size-ratchet limit and every remaining credit /
 * selling-restrictions call site must grow it). None of the four uses `this`; the class keeps thin
 * same-signature delegators so no call site and no spec (incl. `OrdersService.prototype
 * .resolveBuyerLinePrice` in the order-templates specs) changes.
 */

import { PriceType } from "@prisma/client";
import {
  applyBestPromotion,
  computeLineSubtotal,
  getTierPrice,
  normalizeBoxesPieces,
  promotionMatchesProduct,
  roundMoney,
  type PromoContext,
  type PromotionRule,
} from "@routeflow/pricing";
import { isSpecialPrice } from "./units-prices-v2";

/**
 * BUY_N_GET_M free units for a line whose QUANTITY changed while its stored
 * (agreed) unitPrice is kept — pending-order merges and every stored-price qty
 * edit. Reusing the sale-time snapshot verbatim is wrong in BOTH directions: a
 * merged (bigger) line loses the units it just earned and bills at full price,
 * and a shrunk line keeps free units it no longer earns (a 12→2 box door edit
 * billed $0.00). Lines that never earned free units return 0 untouched, so no
 * operator/driver line can gain a promo it never had — UNLESS `canEarnNew` says
 * this is a buyer's own consolidation of buyer-priced lines, where the combined
 * quantity must earn what a single cart of the same size would have (3 + 3 boxes
 * under a live buy-5-get-1 = 1 free, not 0).
 *
 * Preference order: re-run the LIVE BUY_N_GET_M rule against the new whole-unit
 * count (exact — `floor(qtyUnits / (N + M)) * M`); if no active rule still
 * covers the product (the promo ended after the sale) rescale the earned
 * snapshot at the rate it was earned at, capped at the snapshot, so an
 * already-agreed discount is never silently revoked by a later qty tweak.
 */
export function rescaleBogoFreeUnits(input: {
  /** Active promo rules (any type — only BUY_N_GET_M ones are consulted). */
  promos: PromotionRule[];
  productId: string | null;
  category: string | null;
  /** The line's stored selling-unit price — BOGO never alters it, so it IS the base. */
  unitPrice: number;
  storedFreeUnits: number | null | undefined;
  /** Whole selling units the snapshot was earned at. */
  oldUnits: number;
  /** Whole selling units after the change. */
  newUnits: number;
  /**
   * Allow a line with NO snapshot to earn free units from the live rule. Only a
   * buyer-driven merge of buyer-priced lines sets this; every staff qty edit and
   * the hourly sweep leave it false, so an operator/driver line is never silently
   * discounted by a customer promo it never had.
   */
  canEarnNew?: boolean;
}): number {
  const stored = Math.max(0, Math.trunc(Number(input.storedFreeUnits ?? 0) || 0));
  if (stored <= 0 && !input.canEarnNew) return 0;
  const newUnits = Math.max(0, Math.trunc(Number(input.newUnits) || 0));
  if (newUnits <= 0) return 0;
  // A line is never entirely free — the buyer always pays the N in every (N + M).
  const ceiling = Math.max(0, newUnits - 1);
  if (input.productId) {
    const ctx: PromoContext = {
      productId: input.productId,
      category: input.category,
      // BUY_N_GET_M reads only qtyUnits; qtyPieces gates QTY_BREAK, which the
      // filtered list below cannot contain.
      qtyPieces: newUnits,
      qtyUnits: newUnits,
    };
    const live = input.promos.filter(
      (p) => p.type === "BUY_N_GET_M" && promotionMatchesProduct(p, ctx),
    );
    if (live.length > 0) {
      return Math.min(ceiling, applyBestPromotion(input.unitPrice, live, ctx).freeUnits);
    }
  }
  const oldUnits = Math.max(0, Math.trunc(Number(input.oldUnits) || 0));
  if (oldUnits <= 0) return 0;
  return Math.min(ceiling, stored, Math.floor((stored * newUnits) / oldUnits));
}

/**
 * Is this line's price the buyer's own (the tier/promo ladder), rather than an
 * operator-set one? Only such a line may EARN BUY_N_GET_M free units it never had
 * when a buyer-driven merge grows its quantity — a MANUAL upsell or a DISCOUNTED
 * override is a deliberate operator price and is never discounted further by a
 * customer promo (same rule as the manual-override branch in updateOrderItems).
 * A missing priceType counts as NOT buyer-priced (money-safe default).
 */
export function isBuyerPricedLine(li: {
  priceType?: PriceType | null;
  overriddenBy?: string | null;
}): boolean {
  return (
    li.overriddenBy == null &&
    (li.priceType === PriceType.STANDARD ||
      li.priceType === PriceType.SPECIAL ||
      li.priceType === PriceType.PROMO)
  );
}

/**
 * Combine one or more contributing order lines for the SAME product into a
 * single merged line total. Boxed products price by the BOX, so every
 * contribution is normalized to a total PIECE count first, then re-split and
 * priced via `computeLineSubtotal` — a plain `qty * unitPrice` over-charges a
 * boxed line by `unitsPerBox`. Handles mixed denominations: a box-split line
 * (`boxes`/`pieces` set) stores `qty` as pieces; a selling-unit boxed line
 * (`boxes==null`, from the box-unaware mobile cart) stores `qty` as a box
 * count, so its pieces are `qty * unitsPerBox`. The merged line is always
 * emitted piece-denominated (heals the inconsistency). Non-boxed products fall
 * back to a simple qty sum × unit price.
 *
 * BUY_N_GET_M: the merged quantity earns its OWN free units — the contributing
 * snapshots are re-derived against the combined whole-unit count (see
 * `rescaleBogoFreeUnits`) and returned so the caller persists `promoFreeUnits`
 * alongside the subtotal. Without this a merged BOGO line silently repriced to
 * full price while the row kept a stale, contradicting `promoFreeUnits`.
 * `bogo.canEarnNew` additionally lets the combined quantity earn free units none
 * of the contributions had (a buyer's split carts) — granted only when EVERY
 * contribution is buyer-priced, so one operator-priced contribution keeps the
 * whole merged line on the conservative "never gain a promo it never had" path.
 */
export function mergeBoxedContributions(
  contributions: Array<{
    qty: unknown;
    boxes: number | null;
    pieces: number | null;
    promoFreeUnits?: number | null;
    priceType?: PriceType | null;
    overriddenBy?: string | null;
  }>,
  unitPrice: number,
  unitsPerBox: number | null | undefined,
  bogo?: {
    promos: PromotionRule[];
    productId: string | null;
    category: string | null;
    canEarnNew?: boolean;
    /**
     * The merged line's surviving unitPrice already carries a price-promo
     * discount (winner/meta line is PROMO with a strikethrough). Promotions
     * never stack — a buyer splitting one cart in two must not merge back to
     * a percent discount PLUS free units — so both the stored-snapshot rescale
     * and canEarnNew are suppressed and the merged line keeps price-off only.
     */
    pricePromoApplied?: boolean;
  },
): {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  subtotal: number;
  freeUnits: number;
  /** Σ of the contributions' BUY_N_GET_M snapshots — 0 when no line carried one. */
  storedFreeUnits: number;
} {
  const upb = Number(unitsPerBox ?? 0);
  const totalPieces = contributions.reduce((sum, c) => {
    const q = Number(c.qty);
    const sellingUnit = upb > 1 && c.boxes == null && c.pieces == null;
    return sum + (sellingUnit ? q * upb : q);
  }, 0);
  // Free-unit snapshots and the whole selling units they were earned at. A
  // box-split line counts its BOXES (its `qty` is pieces); every other shape
  // already stores selling units in `qty`.
  const storedFreeUnits = contributions.reduce(
    (sum, c) => sum + Math.max(0, Number(c.promoFreeUnits ?? 0) || 0),
    0,
  );
  const oldUnits = contributions.reduce(
    (sum, c) => sum + (c.boxes != null ? Number(c.boxes) : Number(c.qty)),
    0,
  );
  const canEarnNew = bogo?.canEarnNew === true && contributions.every((c) => isBuyerPricedLine(c));
  const freeUnitsFor = (newUnits: number) =>
    bogo?.pricePromoApplied === true
      ? 0
      : rescaleBogoFreeUnits({
          promos: bogo?.promos ?? [],
          productId: bogo?.productId ?? null,
          category: bogo?.category ?? null,
          unitPrice,
          storedFreeUnits,
          oldUnits,
          newUnits,
          canEarnNew,
        });
  if (upb > 1) {
    const split = normalizeBoxesPieces({ qty: totalPieces, unitsPerBox: upb });
    const freeUnits = freeUnitsFor(Number(split.boxes ?? 0));
    return {
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      freeUnits,
      storedFreeUnits,
      subtotal: computeLineSubtotal({
        unitPrice,
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox: upb,
        freeUnits,
      }),
    };
  }
  const freeUnits = freeUnitsFor(totalPieces);
  return {
    qty: totalPieces,
    boxes: null,
    pieces: null,
    freeUnits,
    storedFreeUnits,
    subtotal: computeLineSubtotal({ unitPrice, qty: totalPieces, freeUnits }),
  };
}

/**
 * P5-04: resolve a buyer catalog line's price = tier price, then the best
 * applicable promotion (net unitPrice + originalPrice strikethrough, priceType
 * PROMO). With no promo it reproduces the standard ladder (SPECIAL for tier≠1
 * with the list price as the strikethrough, else STANDARD). Boxed proration is
 * left to computeLineSubtotal by the caller — this only sets the SELLING-UNIT
 * price. `promos` is empty for staff, so this is a no-op tier resolver there.
 * Shared with OrderTemplatesService (REG-B48): a standing order is priced as
 * the customer's own buyer checkout, whoever triggers it.
 */
export function resolveBuyerLinePrice(
  product: { id: string; category: string | null; pricePerUnit: unknown },
  tierForProduct: number,
  promos: PromotionRule[],
  qtyPieces: number,
  qtyUnits: number,
  rememberedPrice?: number | null,
  /**
   * REG-B109: the line's box/piece denomination — the SAME values the caller
   * then feeds `computeLineSubtotal` — so promo SELECTION compares candidates
   * by the money this line will actually be billed, loose pieces included.
   * Without it, a mixed line (whole boxes + loose pieces) is compared on whole
   * boxes only and a BUY_N_GET_M can beat a deeper price promo that in fact
   * bills less. Optional and defaulted: omitting it keeps the whole-selling-unit
   * approximation, which is already exact for any line with no loose pieces.
   */
  denomination?: {
    boxes: number | null;
    pieces: number | null;
    unitsPerBox: number | null;
  },
  /**
   * S19, flag.units_prices_v2 only: the customer's TYPED pack price. It replaces the tier price as the base (and wins
   * over the sticky upsell); promotions still apply on top. Undefined = master's path, untouched.
   */
  typedPrice?: number | null,
): {
  unitPrice: number;
  originalPrice: number | null;
  priceType: PriceType;
  /** BUY_N_GET_M: whole free selling units this line earned. 0 for every other case. */
  freeUnits: number;
} {
  const listPrice = Number(product.pricePerUnit);
  const typed = typedPrice ?? null;
  const tierBase = typed != null ? roundMoney(typed) : getTierPrice(product, tierForProduct);
  const remembered = typed != null ? null : (rememberedPrice ?? null);
  // Sticky upsell: ONLY a remembered ABOVE-LIST price becomes a MANUAL upsell.
  // It overrides the tier AND takes precedence over promotions (a deliberate
  // above-market price is never auto-discounted). Stored as MANUAL with the list
  // base so the operator sees the upsell and the customer's read is redacted
  // (upsell-redaction.ts). A premium tier (tierBase > list) is the customer's
  // normal price, NOT an upsell — it must not trip this branch.
  if (remembered != null && Number(remembered) > listPrice) {
    return {
      unitPrice: roundMoney(Number(remembered)),
      originalPrice: listPrice,
      priceType: PriceType.MANUAL,
      freeUnits: 0,
    };
  }
  const base = tierBase;
  const promo = applyBestPromotion(base, promos, {
    productId: product.id,
    category: product.category,
    qtyPieces,
    qtyUnits,
    boxes: denomination?.boxes ?? null,
    pieces: denomination?.pieces ?? null,
    unitsPerBox: denomination?.unitsPerBox ?? null,
  });
  if (promo.appliedPromoId) {
    return {
      unitPrice: promo.unitPrice,
      originalPrice: promo.originalPrice,
      priceType: PriceType.PROMO,
      freeUnits: promo.freeUnits,
    };
  }
  if (isSpecialPrice(tierForProduct, listPrice, typed)) {
    return {
      unitPrice: base,
      originalPrice: listPrice,
      priceType: PriceType.SPECIAL,
      freeUnits: 0,
    };
  }
  return { unitPrice: base, originalPrice: null, priceType: PriceType.STANDARD, freeUnits: 0 };
}
