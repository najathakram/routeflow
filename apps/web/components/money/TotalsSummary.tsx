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
  /**
   * The customer's tax exemption is not known yet (their record is still loading), so the tax, the levy and the total
   * are not known either: those rows read "—" until it is. A figure that may be wrong is never shown.
   */
  taxPending?: boolean;
  /** An input rendered in the Discount / Shipping row (the order builder edits them in place). */
  discountInput?: React.ReactNode;
  shippingInput?: React.ReactNode;
  className?: string;
}

/** What a figure reads while it cannot be known yet. */
export const PENDING = "—";

export const taxLabel = (taxRatePct?: number | null): string =>
  taxRatePct && taxRatePct > 0 ? `Tax (${Number(taxRatePct)}%)` : "Tax";

export function TotalsSummary({
  totals,
  taxRatePct,
  taxPending = false,
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
          <label className="flex items-center gap-2">
            {discountInput ? "Order discount" : "Discount"}
            {discountInput}
          </label>
          {totals.discount > 0 && (
            <span className="text-amber-600">−{formatMoney(totals.discount)}</span>
          )}
        </div>
      )}
      <div className={row}>
        <span>{taxLabel(taxRatePct)}</span>
        <span data-testid="totals-summary-tax">
          {taxPending ? PENDING : formatMoney(totals.tax)}
        </span>
      </div>
      {totals.chargeLines.map((c) => (
        <div key={c.key} className={row} data-testid="totals-charge-row">
          <span>{c.label}</span>
          <span>{taxPending ? PENDING : formatMoney(c.amount)}</span>
        </div>
      ))}
      {(shippingInput || totals.shipping > 0) && (
        <div className={row}>
          <label className="flex items-center gap-2">
            Shipping fee
            {shippingInput}
          </label>
          {totals.shipping > 0 && (
            <span className="text-navy">+{formatMoney(totals.shipping)}</span>
          )}
        </div>
      )}
      <div className="flex justify-between border-t border-surface-border pt-1.5 font-semibold tabular-nums text-navy">
        <span>Total</span>
        <span data-testid="totals-summary-total">
          {taxPending ? PENDING : formatMoney(totals.total)}
        </span>
      </div>
    </div>
  );
}
