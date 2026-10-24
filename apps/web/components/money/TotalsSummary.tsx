import * as React from "react";
import { formatMoney } from "@/lib/format";
import type { OrderBuilderTotals } from "@/lib/order-builder-totals";

/**
 * W-882: the ONE totals block of a sale being built (order builder panel; the same rows anywhere a pre-save breakdown
 * shows). Rows, always in this order: Subtotal, Discount, Tax, each regulated charge, Shipping, Total. Every figure comes
 * from `orderBuilderTotals` and prints through `formatMoney`, so the panel, the footer and the saved order agree to the cent.
 */
export interface TotalsSummaryProps {
  totals: Pick<
    OrderBuilderTotals,
    "subtotal" | "tax" | "discount" | "shipping" | "total" | "chargeLines"
  >;
  /** The tenant's tax rate in percent; the label reads "Tax (8.25%)" only when a rate is set, else "Tax". */
  taxRatePct?: number | null;
  /** An input rendered in the Discount / Shipping row (the order builder edits them in place). */
  discountInput?: React.ReactNode;
  shippingInput?: React.ReactNode;
  className?: string;
}

export const taxLabel = (taxRatePct?: number | null): string =>
  taxRatePct && taxRatePct > 0 ? `Tax (${Number(taxRatePct)}%)` : "Tax";

export function TotalsSummary({
  totals,
  taxRatePct,
  discountInput,
  shippingInput,
  className,
}: TotalsSummaryProps) {
  const row = "flex items-center justify-between gap-3 tabular-nums text-navy/70";
  return (
    <div
      data-testid="totals-summary"
      className={
        className ??
        "space-y-1.5 rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm"
      }
    >
      <div className={row}>
        <span>Subtotal</span>
        <span>{formatMoney(totals.subtotal)}</span>
      </div>
      {(discountInput || totals.discount > 0) && (
        <div className={row}>
          <span className="flex items-center gap-2">
            {discountInput ? "Order discount" : "Discount"}
            {discountInput}
          </span>
          {totals.discount > 0 && (
            <span className="text-amber-600">−{formatMoney(totals.discount)}</span>
          )}
        </div>
      )}
      <div className={row}>
        <span>{taxLabel(taxRatePct)}</span>
        <span>{formatMoney(totals.tax)}</span>
      </div>
      {totals.chargeLines.map((c) => (
        <div key={c.key} className={row} data-testid="totals-charge-row">
          <span>{c.label}</span>
          <span>{formatMoney(c.amount)}</span>
        </div>
      ))}
      {(shippingInput || totals.shipping > 0) && (
        <div className={row}>
          <span className="flex items-center gap-2">
            Shipping fee
            {shippingInput}
          </span>
          {totals.shipping > 0 && (
            <span className="text-navy">+{formatMoney(totals.shipping)}</span>
          )}
        </div>
      )}
      <div className="flex justify-between border-t border-surface-border pt-1.5 font-semibold tabular-nums text-navy">
        <span>Total</span>
        <span data-testid="totals-summary-total">{formatMoney(totals.total)}</span>
      </div>
    </div>
  );
}
