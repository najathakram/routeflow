"use client";

import * as React from "react";
import { formatReceiptMoney } from "@routeflow/pricing";

/**
 * CQ-17: after "Complete & next sale" the screen is a fresh sale at once, so the clerk would otherwise never see which order
 * the sale they just finished became. The note holds that order number until the next sale gets its first line. State only:
 * the screen sets it when a sale finishes, and this hook drops it the moment the cart has a line again.
 */
export interface LastSaleNote {
  orderNumber: string;
  /** Cash handed back: the server's own `res.change`, never recomputed here. */
  change?: number;
  method?: string;
}

/** The note a finished sale leaves: taken from the server's answer BEFORE the screen resets. */
export function lastSaleNoteFrom(res: {
  orderNumber: string;
  change?: number;
  method?: string;
}): LastSaleNote {
  return {
    orderNumber: res.orderNumber,
    ...(res.change != null && res.change > 0 ? { change: res.change } : {}),
    ...(res.method ? { method: res.method } : {}),
  };
}

export function useLastSaleNote(lineCount: number) {
  const [note, setNote] = React.useState<LastSaleNote | null>(null);
  React.useEffect(() => {
    if (lineCount > 0) setNote(null);
  }, [lineCount]);
  return [note, setNote] as const;
}

/** The money moment's tail: change due (cash with change), or how the sale was paid. */
function paidTail(note: LastSaleNote): { text: string; big: boolean } | null {
  if (note.method === "CASH") {
    return note.change != null && note.change > 0
      ? { text: `Change due ${formatReceiptMoney(note.change)}`, big: true }
      : null;
  }
  if (note.method === "CARD") return { text: "Paid by card", big: false };
  if (note.method === "CHECK") return { text: "Paid by check", big: false };
  if (note.method === "ON_ACCOUNT") return { text: "On account", big: false };
  return note.change != null && note.change > 0
    ? { text: `Change due ${formatReceiptMoney(note.change)}`, big: true }
    : null;
}

export function CounterLastSale({ note }: { note: LastSaleNote }) {
  const { orderNumber } = note;
  const ref = React.useRef<HTMLParagraphElement>(null);
  // At 390 the sale screen sits inside a scroll container the clerk had scrolled down to the Complete buttons, so the fresh
  // sale's note (which is above the cart) rendered above the viewport. Bring it into view, moving the page no more than needed.
  React.useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [orderNumber]);
  const tail = paidTail(note);
  return (
    <p
      ref={ref}
      role="status"
      className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
      data-testid="counter-last-sale"
    >
      Sale <span className="font-semibold">{orderNumber}</span> completed
      {tail ? (
        <>
          {" · "}
          <span className={tail.big ? "text-lg font-semibold" : "font-semibold"}>{tail.text}</span>
        </>
      ) : (
        "."
      )}
    </p>
  );
}
