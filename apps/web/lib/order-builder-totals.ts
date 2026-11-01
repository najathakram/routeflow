import { roundMoney, saleTotals, type ChargeLine } from "@routeflow/pricing";
import { saleLinesOf, type CartCategory } from "./sale-lines";

/**
 * The order builder's footer and panel total (W-882): the SAME figure the server writes on the order and the invoice,
 * from the one `saleTotals` (@routeflow/pricing). No inline `subtotal * rate`, so a $10.00 line at 8.25% reads $10.83 and
 * not the unrounded 10.825. A tax-exempt customer owes neither the sales tax nor the regulated levy.
 */
export interface OrderBuilderLine {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** The product's regulated category, snapshotted when the line was added. */
  trackedCategoryId?: string | null;
}

export interface OrderBuilderTotalsContext {
  /** The tenant's sales-tax rate as a percent (8.25), as the settings API serves it. */
  taxRatePct?: number | null;
  categoryById?: ReadonlyMap<string, CartCategory>;
  isTaxExempt?: boolean;
  discount?: number | null;
  shipping?: number | null;
}

export interface OrderBuilderTotals {
  subtotal: number;
  /** the sales tax */
  tax: number;
  /** the regulated levy, summed */
  charges: number;
  discount: number;
  shipping: number;
  total: number;
  /** the levy as named charges, one per regulated category */
  chargeLines: ChargeLine[];
}

export function orderBuilderTotals(
  lines: readonly OrderBuilderLine[],
  ctx: OrderBuilderTotalsContext = {},
): OrderBuilderTotals {
  // the server writes the order discount to the cent (roundMoney); a typed 1.005 must take off the same cents here
  const discount = roundMoney(Number(ctx.discount ?? 0) || 0);
  const t = saleTotals(saleLinesOf(lines, ctx.categoryById), {
    taxRate: (Number(ctx.taxRatePct ?? 0) || 0) / 100,
    isTaxExempt: ctx.isTaxExempt === true,
    discount,
    shipping: ctx.shipping,
  });
  return {
    subtotal: t.subtotal,
    tax: t.regularTax,
    charges: t.categoryTax,
    discount,
    shipping: Number(ctx.shipping ?? 0) || 0,
    total: t.total,
    chargeLines: t.chargeLines,
  };
}
