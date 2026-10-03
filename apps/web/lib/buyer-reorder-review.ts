import { applyBestPromotion, computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import type { PromotionRule } from "@routeflow/pricing";
import type { BuyerOrderTemplate, BuyerProduct } from "@/lib/api/buyer";

/**
 * Review figures for a standing-order "Reorder". Mirrors how the server prices a template run
 * (`order-templates.service.ts` createOrderFromTemplate) for the lines it prices from the
 * catalog row: a template qty is a SELLING-UNIT count (a box for a boxed product, bought at
 * the BOX price), the promo context sees the true piece count (qty x unitsPerBox), and the line
 * bills `computeLineSubtotal({ unitPrice, qty, freeUnits })` — the one shared money helper,
 * never `qty * unitPrice` re-derived here. A line whose product is not in the buyer's catalog
 * is `unresolved`: it is excluded from the total (never counted as $0) and the sheet says so.
 * The catalog `buyerPrice` already carries the buyer's tier and any remembered above-list price,
 * so the only divergence from the server is promotion stacking on a remembered above-list price.
 * Tax is added by the server when the order is placed, so the total is an ESTIMATE of the
 * subtotal — the same stance as the cart.
 */
export interface ReorderReviewLine {
  id: string;
  name: string;
  unit: string;
  qty: number;
  unresolved: boolean;
  /** Net selling-unit price after the best promotion; null when unresolved. */
  unitPrice: number | null;
  /** Whole selling units made free by a BUY_N_GET_M promotion. */
  freeUnits: number;
  /** Line total; null when unresolved. */
  lineSubtotal: number | null;
}

export interface ReorderReview {
  lines: ReorderReviewLine[];
  subtotal: number;
  unresolvedCount: number;
}

/** Lines the server will actually order: a suspended line is never placed by a manual run. */
export function liveTemplateItems(template: BuyerOrderTemplate): BuyerOrderTemplate["items"] {
  return template.items.filter((i) => !i.suspendedAt);
}

export function priceReorderReview(
  template: BuyerOrderTemplate,
  products: Array<Pick<BuyerProduct, "id" | "buyerPrice" | "category" | "unitsPerBox">>,
  promoRules: PromotionRule[],
): ReorderReview {
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = liveTemplateItems(template).map((item): ReorderReviewLine => {
    const base = {
      id: item.id,
      name: item.product.name,
      unit: item.product.unit,
      qty: item.qty,
    };
    const product = byId.get(item.productId);
    if (!product) {
      return { ...base, unresolved: true, unitPrice: null, freeUnits: 0, lineSubtotal: null };
    }
    const upb = Number(product.unitsPerBox ?? 0);
    const promo = applyBestPromotion(product.buyerPrice, promoRules, {
      productId: item.productId,
      category: product.category ?? null,
      qtyPieces: upb > 1 ? item.qty * upb : item.qty,
      qtyUnits: item.qty,
      boxes: null,
      pieces: null,
      unitsPerBox: upb,
    });
    const freeUnits = promo.freeUnits ?? 0;
    return {
      ...base,
      unresolved: false,
      unitPrice: promo.unitPrice,
      freeUnits,
      lineSubtotal: computeLineSubtotal({
        unitPrice: promo.unitPrice,
        qty: item.qty,
        freeUnits,
      }),
    };
  });
  const subtotal = roundMoney(lines.reduce((sum, l) => sum + (l.lineSubtotal ?? 0), 0));
  return { lines, subtotal, unresolvedCount: lines.filter((l) => l.unresolved).length };
}
