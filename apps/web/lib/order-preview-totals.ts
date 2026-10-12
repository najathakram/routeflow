import { roundMoney } from "@routeflow/pricing";

/**
 * The staff order preview's money rows, so what is shown ADDS UP to the order's own total: Subtotal, Tax (the regular tax:
 * `Order.tax` never holds the levy), one named row per regulated charge, Discount (negative) and Shipping, from the order's
 * own columns. Whatever the header still carries beyond those is one plain "Adjustment" row: a staff edit or merge writes
 * the total without subtracting the stored discountAmount, so the gap is shown, never hidden or relabelled as tax.
 */
export interface OrderPreviewTotalsSource {
  subtotal: number | string | null | undefined;
  tax: number | string | null | undefined;
  charges: ReadonlyArray<{ key: string; label: string; amount: number }>;
  discountAmount?: number | string | null;
  shippingFee?: number | string | null;
  total: number | string | null | undefined;
}

export interface OrderPreviewRow {
  key: string;
  label: string;
  /** signed: a discount is negative */
  amount: number;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

export function orderPreviewTotalsRows(o: OrderPreviewTotalsSource): OrderPreviewRow[] {
  const rows: OrderPreviewRow[] = [
    { key: "subtotal", label: "Subtotal", amount: roundMoney(n(o.subtotal)) },
    { key: "tax", label: "Tax", amount: roundMoney(n(o.tax)) },
  ];
  for (const c of o.charges)
    rows.push({ key: `charge-${c.key}`, label: c.label, amount: c.amount });
  const discount = roundMoney(n(o.discountAmount));
  if (discount > 0) rows.push({ key: "discount", label: "Discount", amount: -discount });
  const shipping = roundMoney(n(o.shippingFee));
  if (shipping > 0) rows.push({ key: "shipping", label: "Shipping", amount: shipping });
  const shown = roundMoney(rows.reduce((s, r) => s + r.amount, 0));
  const gap = roundMoney(n(o.total) - shown);
  if (gap !== 0) rows.push({ key: "adjustment", label: "Adjustment", amount: gap });
  return rows;
}
