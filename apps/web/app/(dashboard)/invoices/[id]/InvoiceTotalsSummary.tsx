import { cn } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";

export interface InvoiceTotalsSummaryProps {
  subtotal: number;
  discount: number;
  taxAmount: number;
  shippingFee: number;
  /** Cash only (B421) — a credit note or advance is never included here. */
  amountPaid: number;
  /** Confirmed CREDIT_NOTE applications — reduces balanceDue, never cash. */
  creditApplied: number;
  /** Confirmed ADVANCE applications — reduces balanceDue, never cash. */
  advanceApplied: number;
  balanceDue: number;
}

/**
 * The invoice detail page's line-items totals footer (Subtotal → Balance
 * due). Extracted from `page.tsx` (B421, independent review) so the
 * operator-facing wording — "Payments received" is cash only; "Credits
 * applied"/"Advance applied" are separate, neutral-styled lines, never
 * folded into "Paid" — is directly RTL-testable without mounting the whole
 * page (which needs auth/query-client/router context this component does
 * not). See `InvoiceTotalsSummary.test.tsx` and lesson L-159.
 */
export function InvoiceTotalsSummary({
  subtotal,
  discount,
  taxAmount,
  shippingFee,
  amountPaid,
  creditApplied,
  advanceApplied,
  balanceDue,
}: InvoiceTotalsSummaryProps) {
  return (
    <div className="w-72 space-y-1.5 text-sm">
      <div className="flex justify-between py-0.5">
        <span className="text-navy/70">Subtotal</span>
        <span className="money text-navy">{fmt(subtotal)}</span>
      </div>
      {discount > 0 && (
        <div className="flex justify-between py-0.5 text-success">
          <span>Discount</span>
          <span className="money">-{fmt(discount)}</span>
        </div>
      )}
      {taxAmount > 0 && (
        <div className="flex justify-between py-0.5">
          <span className="text-navy/70">Tax</span>
          <span className="money text-navy">{fmt(taxAmount)}</span>
        </div>
      )}
      {shippingFee > 0 && (
        <div className="flex justify-between py-0.5">
          <span className="text-navy/70">Shipping</span>
          <span className="money text-navy">{fmt(shippingFee)}</span>
        </div>
      )}
      {/* B421: show "Payments received" whenever ANY confirmed payment
          activity exists, even $0 cash — a credit/advance-only invoice must
          say explicitly that no cash came in, not just omit the cash line
          and leave the balance reduction unexplained. */}
      {(amountPaid > 0 || creditApplied > 0 || advanceApplied > 0) && (
        <div className="flex justify-between py-0.5 text-success">
          <span>Payments received</span>
          <span className="money">-{fmt(amountPaid)}</span>
        </div>
      )}
      {/* A credit note or advance reduces the balance but is never cash
          received — neutral styling, never text-success. */}
      {creditApplied > 0 && (
        <div className="flex justify-between py-0.5 text-navy/70">
          <span>Credits applied</span>
          <span className="money">-{fmt(creditApplied)}</span>
        </div>
      )}
      {advanceApplied > 0 && (
        <div className="flex justify-between py-0.5 text-navy/70">
          <span>Advance applied</span>
          <span className="money">-{fmt(advanceApplied)}</span>
        </div>
      )}
      <div
        className={cn(
          "mt-1.5 flex items-center justify-between border-t border-navy pt-2.5 text-base font-semibold",
          balanceDue > 0 ? "text-danger" : "text-success",
        )}
      >
        <span>Balance due</span>
        <span className="money">{fmt(balanceDue)}</span>
      </div>
    </div>
  );
}
