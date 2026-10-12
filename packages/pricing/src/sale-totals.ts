import { computeCategoryTax, type CategoryTaxType } from "./pricing";
import { regulatedUnitBasis } from "./regulated-unit-basis";
import { chargeLinesOf, type ChargeLine } from "./charge-lines";
import {
  computeInvoiceLineTotal,
  sumInvoiceTotals,
  type SummedInvoiceTotals,
} from "./invoice-totals";

/**
 * The till's cart (and any pre-save footer): the SAME totals the server writes on the order and the invoice.
 *
 * A client that knows each line's price, pack split and regulated category (`category`) and the customer's
 * exemption gets, to the cent, the figure `orders.service` stores and the invoice prints. It never re-derives a
 * line (`computeInvoiceLineTotal`), a levy (`computeCategoryTax` over `regulatedUnitBasis`, the one pieces
 * conversion) or the sum (`sumInvoiceTotals`, the formula every server writer shares).
 *
 * A tax-exempt customer owes $0 of BOTH the sales tax and the levy (RF-079 / RF-4), exactly as the invoice does.
 */
export interface SaleTotalsLine {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  freeUnits?: number | null;
  /** Per-line money discount off the line's boxed-aware subtotal. Default 0. */
  discount?: number | null;
  /** The line's regulated category (levy) config; null / absent = unregulated. */
  category?: {
    /** the category's id and name: the levy prints as its own named charge line (`chargeLines`). */
    id?: string | null;
    name?: string | null;
    taxType: CategoryTaxType;
    /** PERCENT_OF_SALE: a fraction; otherwise money per unit. */
    rate: number;
    priceIncludesTax?: boolean | null;
  } | null;
}

export interface SaleTotalsOptions {
  /** The tenant's sales-tax rate as a fraction (0.0825). Default 0. */
  taxRate?: number | null;
  isTaxExempt?: boolean | null;
  discount?: number | null;
  shipping?: number | null;
}

export interface SaleTotals extends SummedInvoiceTotals {
  /** Each line's post-discount total, same order as the input. */
  lineTotals: number[];
  /** Each line's levy (0 for an exempt customer), same order as the input. */
  lineCategoryTax: number[];
  /** The levy as named charges, one per regulated category: "CRV deposit", "Tobacco excise" (CQ-03 / CQ-08). */
  chargeLines: ChargeLine[];
}

export function saleTotals(
  lines: readonly SaleTotalsLine[],
  opts: SaleTotalsOptions = {},
): SaleTotals {
  const exempt = opts.isTaxExempt === true;
  const rate = Number(opts.taxRate ?? 0) || 0;
  const lineTotals = lines.map((l) =>
    computeInvoiceLineTotal({
      unitPrice: l.unitPrice,
      qty: l.qty,
      boxes: l.boxes ?? null,
      pieces: l.pieces ?? null,
      unitsPerBox: l.unitsPerBox ?? null,
      freeUnits: l.freeUnits ?? 0,
      discount: l.discount,
    }),
  );
  const lineCategoryTax = lines.map((l, i) => {
    if (exempt || !l.category) return 0;
    return computeCategoryTax({
      taxType: l.category.taxType,
      rate: Number(l.category.rate),
      unitBasisQty: regulatedUnitBasis(
        { qty: l.qty, boxes: l.boxes ?? null, pieces: l.pieces ?? null },
        l.unitsPerBox,
      ).unitBasisQty,
      lineSubtotal: lineTotals[i],
      priceIncludesTax: l.category.priceIncludesTax ?? false,
    });
  });
  const summed = sumInvoiceTotals(
    lines.map((_, i) => ({
      subtotal: lineTotals[i],
      taxRate: rate,
      categoryTaxAmount: lineCategoryTax[i],
    })),
    { discount: opts.discount, shipping: opts.shipping, isTaxExempt: exempt },
  );
  const chargeLines = chargeLinesOf(
    lines.map((l, i) => ({
      categoryTaxAmount: lineCategoryTax[i],
      categoryId: l.category?.id,
      categoryName: l.category?.name,
      categoryTaxType: l.category?.taxType,
    })),
  );
  return { ...summed, lineTotals, lineCategoryTax, chargeLines };
}
