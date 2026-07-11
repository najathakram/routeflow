/**
 * Buyer-cart promotion pricing — shared by the cart screen and the catalog
 * floating total so both show the SAME number the server will bill.
 *
 * The server authoritatively re-prices every buyer order on submit
 * (OrdersService.resolveBuyerLinePrice → applyBestPromotion for CUSTOMER); the
 * buyer create-order DTO carries no unitPrice. So this is display-only: mobile
 * buyers are already charged the promo price — this just makes the UI match.
 *
 * Mirrors the web buyer cart (`apps/web/app/buyer/portal/[seller]/cart/page.tsx`
 * `pricedLines`): the promo `base` is the stored selling-unit (box) price, the
 * QTY_BREAK gate is on total PIECES, and net line subtotals reconcile to the
 * total via the shared `computeLineSubtotal`.
 */
import {
  applyBestPromotion,
  computeLineSubtotal,
  normalizeBoxesPieces,
  roundMoney,
  type PromotionRule,
} from "./pricing";
import type { BuyerPromotion } from "./api/buyer";

export interface CartLineInput {
  productId: string;
  category?: string | null;
  /** Stored selling-unit price (the box price when boxed) — the promo base. */
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

export interface PricedCartLine {
  productId: string;
  base: number;
  /** Net (post-promo) selling-unit price. */
  net: number;
  /** Strikethrough (pre-promo) price — null when no promo applied. */
  original: number | null;
  appliedPromoId: string | null;
  lineSubtotal: number;
  lineOriginalSubtotal: number;
}

export interface PricedCart {
  lines: PricedCartLine[];
  /** Sum of net line subtotals (what the buyer pays). */
  subtotal: number;
  /** Sum of (pre-promo − net) per line; 0 when nothing is promoted. */
  savings: number;
}

/** Adapt the API `BuyerPromotion[]` to the shared `PromotionRule[]`. */
export function promoRulesFrom(promos: BuyerPromotion[] | undefined): PromotionRule[] {
  return (promos ?? []).map((p) => ({
    id: p.id,
    type: p.type,
    value: p.value,
    minQty: p.minQty,
    scope: p.scope,
    category: p.category,
    productIds: p.productIds,
  }));
}

export function priceCart(items: CartLineInput[], rules: PromotionRule[]): PricedCart {
  const lines: PricedCartLine[] = items.map((item) => {
    const base = item.unitPrice;
    const unitsPerBox = item.unitsPerBox ?? null;
    const qtyPieces = normalizeBoxesPieces({
      boxes: item.boxes ?? null,
      pieces: item.pieces ?? null,
      qty: item.qty,
      unitsPerBox,
    }).qty;
    const promo = applyBestPromotion(base, rules, {
      productId: item.productId,
      category: item.category ?? null,
      qtyPieces,
    });
    const lineArgs = {
      qty: item.qty,
      boxes: item.boxes ?? null,
      pieces: item.pieces ?? null,
      unitsPerBox,
    };
    return {
      productId: item.productId,
      base,
      net: promo.unitPrice,
      original: promo.originalPrice,
      appliedPromoId: promo.appliedPromoId,
      lineSubtotal: computeLineSubtotal({ unitPrice: promo.unitPrice, ...lineArgs }),
      lineOriginalSubtotal: computeLineSubtotal({
        unitPrice: promo.originalPrice ?? promo.unitPrice,
        ...lineArgs,
      }),
    };
  });
  const subtotal = roundMoney(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const savings = roundMoney(
    lines.reduce((s, l) => s + (l.lineOriginalSubtotal - l.lineSubtotal), 0),
  );
  return { lines, subtotal, savings };
}
