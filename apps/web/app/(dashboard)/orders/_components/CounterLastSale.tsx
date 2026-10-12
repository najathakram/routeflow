"use client";

import * as React from "react";

/**
 * CQ-17: after "Complete & next sale" the screen is a fresh sale at once, so the clerk would otherwise never see which order
 * the sale they just finished became. The note holds that order number until the next sale gets its first line. State only:
 * the screen sets it when a sale finishes, and this hook drops it the moment the cart has a line again.
 */
export function useLastSaleNote(lineCount: number) {
  const [orderNumber, setOrderNumber] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (lineCount > 0) setOrderNumber(null);
  }, [lineCount]);
  return [orderNumber, setOrderNumber] as const;
}

export function CounterLastSale({ orderNumber }: { orderNumber: string }) {
  return (
    <p
      role="status"
      className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
      data-testid="counter-last-sale"
    >
      Sale <span className="font-semibold">{orderNumber}</span> completed.
    </p>
  );
}
