"use client";

import type { BuyerCartQuote } from "@/lib/api/buyer";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/** Said under the subtotal while there is no quote (pending, failed, throttled or nothing priceable). */
export const QUOTE_FALLBACK_COPY = "Any tax and fees are added to your order.";

export function unresolvedNote(n: number): string {
  return n === 1
    ? "1 item isn't priced here and isn't in this total. Your seller will confirm its price when they review the order."
    : `${n} items aren't priced here and aren't in this total. Your seller will confirm their prices when they review the order.`;
}

interface Props {
  /** The server's quote for exactly this cart; undefined = none (the fallback shows). */
  quote: BuyerCartQuote | undefined;
  /** A newer quote is loading: the figures stay, dimmed, and are not announced until it settles. */
  busy: boolean;
  /** The submit will fold into the open order: the last row reads "Total for these items". */
  merging: boolean;
  /** The client's own priced subtotal (promotion-aware) and savings, used only while there is no quote. */
  clientSubtotal: number;
  savings: number;
  unresolvedCount: number;
  /** "Subtotal (3 items)" in the cart, plain "Subtotal" in the reorder sheet. */
  subtotalLabel: string;
}

/**
 * SA-1172 (B304): the buyer's money rows. With a quote EVERY row comes from it (K7: never mix sources), so the rows add
 * up to the total; the client's promotion rows show only while its subtotal still agrees with the quote's within 1 cent.
 * Without one, the client subtotal and one plain line. Place order never reads this.
 */
export function CartQuoteSummary({
  quote,
  busy,
  merging,
  clientSubtotal,
  savings,
  unresolvedCount,
  subtotalLabel,
}: Props) {
  const totalLabel = merging ? "Total for these items" : "Total";
  const promoAgrees = quote != null && Math.abs(clientSubtotal - quote.subtotal) < 0.01;
  const showPromo = savings > 0 && (quote == null || promoAgrees);
  const subtotal = quote ? quote.subtotal : clientSubtotal;
  return (
    <div className={busy && quote ? "space-y-3 opacity-60" : "space-y-3"} aria-busy={busy}>
      {showPromo && (
        <>
          <div className="flex justify-between text-sm">
            <span className="text-navy/70">Items</span>
            <span className="text-navy/70 line-through">{fmt(subtotal + savings)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-buyer-600">Promotion savings</span>
            <span className="font-medium text-buyer-600">−{fmt(savings)}</span>
          </div>
        </>
      )}
      <div className="flex justify-between text-sm">
        <span className="text-navy/70">{subtotalLabel}</span>
        <span className="font-medium text-navy">{fmt(subtotal)}</span>
      </div>
      {quote ? (
        <>
          <div className="flex justify-between text-sm">
            <span className="text-navy/70">Tax</span>
            <span className="font-medium text-navy">{fmt(quote.tax)}</span>
          </div>
          {quote.levy > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-navy/70">Other taxes and fees</span>
              <span className="font-medium text-navy">{fmt(quote.levy)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-surface-border pt-3">
            <span className="text-sm font-semibold text-navy">{totalLabel}</span>
            <span className="text-lg font-bold text-navy">{fmt(quote.total)}</span>
          </div>
        </>
      ) : (
        <p className="text-xs text-navy/60">{QUOTE_FALLBACK_COPY}</p>
      )}
      {!quote && unresolvedCount > 0 && (
        <p className="text-xs text-navy/60">{unresolvedNote(unresolvedCount)}</p>
      )}
      <p role="status" aria-atomic="true" className="sr-only">
        {quote && !busy ? `${totalLabel} ${fmt(quote.total)}` : ""}
      </p>
    </div>
  );
}
