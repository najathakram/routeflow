import { formatReceiptMoney, roundMoney } from "@routeflow/pricing";

/**
 * The customer app's invoice totals, from the server's own figures (GET /buyer/invoices/:id): Subtotal, Tax, one named
 * row per regulated charge ("CRV deposit"), Discount (negative) and Shipping. The tax split is computed server-side with the
 * shared `invoiceTaxSplit` (regularTaxAmount + chargeLines), the same lines the buyer web page and the PDF show: there is
 * no tax name or rate hard-coded here. An older server that sends neither shows the stored header as Tax.
 */
export interface BuyerInvoiceTotalsSource {
  subtotal?: number | string | null;
  /** the stored header: regular tax plus levy */
  taxAmount?: number | string | null;
  regularTaxAmount?: number | string | null;
  chargeLines?: ReadonlyArray<{ key: string; label: string; amount: number | string }> | null;
  discount?: number | string | null;
  shippingFee?: number | string | null;
  total?: number | string | null;
}

export interface TotalsRow {
  key: string;
  label: string;
  /** signed: a discount is negative */
  amount: number;
}

const cents = (v: unknown): number => roundMoney(Number(v ?? 0) || 0);

/** "Discount: -$5.00", "CRV deposit: $2.80": the sign is part of the text, never bare or doubled. */
export function totalsRowText(r: TotalsRow): string {
  return `${r.label}: ${formatReceiptMoney(r.amount)}`;
}

export function buyerInvoiceTotalsRows(inv: BuyerInvoiceTotalsSource): TotalsRow[] {
  if (inv.subtotal == null) return [];
  const rows: TotalsRow[] = [{ key: "subtotal", label: "Subtotal", amount: cents(inv.subtotal) }];
  const tax = cents(inv.regularTaxAmount ?? inv.taxAmount);
  if (tax > 0) rows.push({ key: "tax", label: "Tax", amount: tax });
  for (const c of inv.chargeLines ?? []) {
    const amount = cents(c.amount);
    if (amount !== 0) rows.push({ key: `charge-${c.key}`, label: c.label, amount });
  }
  const discount = cents(inv.discount);
  if (discount > 0) rows.push({ key: "discount", label: "Discount", amount: -discount });
  const shipping = cents(inv.shippingFee);
  if (shipping > 0) rows.push({ key: "shipping", label: "Shipping", amount: shipping });
  return rows;
}
