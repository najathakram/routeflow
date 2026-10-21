"use client";

// Row 342: the "Pickup hand-overs" of the Today's sales sheet (own file so CounterTodaysSales stays small). Server numbers
// only: the same hand-overs the day close counts (a non-counter PICKUP order's own tender), listed for the cashier.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@routeflow/ui/web";
import type { TodaysHandOverRow, TodaysSaleMethod } from "@routeflow/types";
import { formatReceiptMoney as money } from "@/lib/counter-receipt";
import { guardCounterLeave } from "@/lib/counter-cart-signal";

export const METHOD_LABEL: Record<TodaysSaleMethod, string> = {
  ADVANCE: "Advance",
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  OTHER: "Other",
  STORE_CREDIT: "Store credit",
};

/** `Pickup hand-overs · N · $X`: N and $X are the server's `summary.handOvers`, so a day with none still reads $0.00. */
export const handOverHeading = (h: { count: number; total: number }) =>
  `Pickup hand-overs · ${h.count} · ${money(h.total)}`;

/** The Summary's "Pickup hand-overs" figure: `N · $X`. */
export const handOverFigure = (h: { count: number; total: number }) =>
  `${h.count} · ${money(h.total)}`;

/** One method reads its name (the amount is the row's); a split names each part's amount. */
function methodsText(methods: TodaysHandOverRow["methods"]): string {
  if (methods.length === 0) return "";
  if (methods.length === 1) return METHOD_LABEL[methods[0]!.method];
  return methods.map((m) => `${METHOD_LABEL[m.method]} ${money(m.amount)}`).join(" + ");
}

function HandOverRow({
  row,
  timeOf,
}: {
  row: TodaysHandOverRow;
  /** the sale rows' own time formatter, already bound to the tenant's zone */
  timeOf: (iso: string) => string;
}) {
  const router = useRouter();
  const href = `/orders/${row.orderId}`;
  const methods = methodsText(row.methods);
  return (
    <li className="space-y-1 py-3" data-testid={`hand-over-row-${row.orderId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <Link
          href={href}
          className={cn(
            "min-h-11 inline-flex items-center font-medium text-brand-700",
            "min-w-0 break-words",
          )}
          onClick={(e) => {
            // a cart with lines asks "Discard this sale?" first, like the sale rows' View order
            if (guardCounterLeave(() => router.push(href))) e.preventDefault();
          }}
        >
          {row.orderNumber}
        </Link>
        <span className="tabular-nums">{money(row.amount)}</span>
      </div>
      <p className="min-w-0 break-words text-xs text-navy/70">
        {timeOf(row.paidAt)} · {row.customerName}
        {methods ? ` · ${methods}` : ""}
      </p>
      <p className="min-w-0 break-words text-xs text-navy/60">
        Register {row.registerKey}
        {row.handedOverBy ? ` · Handed over by ${row.handedOverBy}` : ""}
      </p>
    </li>
  );
}

/**
 * Hidden when the day had no hand-over rows, and for an older API that sends none (the Summary line still shows the count).
 * The heading figures come from the server's summary, not from counting these rows.
 */
export function HandOverRows({
  rows,
  summary,
  timeOf,
}: {
  rows: readonly TodaysHandOverRow[] | undefined;
  summary: { count: number; total: number };
  timeOf: (iso: string) => string;
}) {
  if (!rows || rows.length === 0) return null;
  return (
    <section aria-labelledby="hand-overs-heading" data-testid="today-hand-overs-section">
      <h3 id="hand-overs-heading" className="text-sm font-semibold">
        {handOverHeading(summary)}
      </h3>
      <ul className="divide-y" aria-label="Pickup hand-overs">
        {rows.map((r) => (
          <HandOverRow key={r.orderId} row={r} timeOf={timeOf} />
        ))}
      </ul>
    </section>
  );
}
