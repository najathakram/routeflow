"use client";

import * as React from "react";
import { Eye, EyeOff, History } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { AnchoredPopover } from "@/components/AnchoredPopover";
import {
  usePriceHistory,
  type PriceHistoryResponse,
  type PriceHistoryRow,
  type PriceHistorySummary,
} from "@/lib/api/price-history";
import { fmt } from "@/lib/formatting";

const MASK = "••••";

/** "case" and "box" name the same selling unit; everything else compares case-insensitively. */
function normUnit(u: string | null | undefined): string {
  const v = (u ?? "").trim().toLowerCase();
  return v === "box" || v === "cases" || v === "boxes" ? "case" : v;
}
export const sameUnit = (a: string | null | undefined, b: string | null | undefined) =>
  normUnit(a) === normUnit(b);

const PRICE_TYPE_TAG: Record<string, string> = {
  SPECIAL: "Special",
  DISCOUNTED: "Discount",
  MANUAL: "Override",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

/** Inline-SVG sparkline of unit price over time (oldest -> newest). No chart library. */
function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) return null;
  const w = 220;
  const h = 36;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * (w - 8) + 4;
    const y = h - 4 - ((p - lo) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1]!.split(",");
  return (
    <svg
      role="img"
      aria-label={`Price trend, ${prices.length} sales`}
      viewBox={`0 0 ${w} ${h}`}
      className="h-9 w-full text-brand-500"
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lx} cy={ly} r="2.5" fill="currentColor" />
    </svg>
  );
}

function Skeleton() {
  return (
    <div role="status" aria-label="Loading price history" className="space-y-2 animate-pulse">
      <div className="h-3 w-40 rounded bg-sunken" />
      <div className="h-9 w-full rounded bg-sunken" />
      <div className="h-3 w-full rounded bg-sunken" />
      <div className="h-3 w-5/6 rounded bg-sunken" />
      <div className="h-3 w-4/6 rounded bg-sunken" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-navy/50">{label}</div>
      <div className="font-mono text-xs text-navy">{value}</div>
    </div>
  );
}

function PanelBody({
  data,
  productName,
  customerName,
  unitHint,
  onUse,
}: {
  data: PriceHistoryResponse;
  productName: string;
  customerName?: string | null;
  unitHint?: string | null;
  onUse: (price: number) => void;
}) {
  const [showCost, setShowCost] = React.useState(false);
  const units = React.useMemo(() => {
    const seen: string[] = [];
    for (const u of [
      ...data.summaries.map((s) => s.unitLabel),
      ...data.rows.map((r) => r.unitLabel),
    ])
      if (!seen.some((s) => sameUnit(s, u))) seen.push(u);
    return seen;
  }, [data]);
  const [picked, setPicked] = React.useState<string | null>(null);
  const unit =
    picked ?? units.find((u) => (unitHint ? sameUnit(u, unitHint) : false)) ?? units[0] ?? null;

  const rows: PriceHistoryRow[] = React.useMemo(
    () =>
      data.rows
        .filter((r) => sameUnit(r.unitLabel, unit))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [data.rows, unit],
  );
  const summary: PriceHistorySummary | undefined = data.summaries.find((s) =>
    sameUnit(s.unitLabel, unit),
  );
  const chronological = [...rows].reverse().map((r) => r.unitPrice);
  const money = (n: number | null | undefined) => (n == null ? "—" : fmt(n));
  const costCell = (n: number | null) => (showCost ? money(n) : MASK);
  const canUse = (r: PriceHistoryRow) => !unitHint || sameUnit(r.unitLabel, unitHint);

  return (
    <div className="space-y-2 text-xs">
      <div>
        <p className="text-sm font-semibold text-navy">
          Price history · {data.productName || productName}
        </p>
        <p className="text-[11px] text-navy/60">Customer: {data.customerName || customerName}</p>
      </div>

      {units.length > 1 && (
        <div role="tablist" aria-label="Unit" className="flex gap-1">
          {units.map((u) => (
            <button
              key={u}
              type="button"
              role="tab"
              aria-selected={sameUnit(u, unit)}
              onClick={() => setPicked(u)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1",
                sameUnit(u, unit)
                  ? "bg-brand-50 text-brand-700 ring-brand-200"
                  : "text-navy/60 ring-surface-border hover:text-navy",
              )}
            >
              {u}
            </button>
          ))}
        </div>
      )}

      <Sparkline prices={chronological} />

      <div className="flex flex-wrap items-end gap-x-4 gap-y-1 border-y border-surface-border py-1.5">
        <Stat label="Last" value={money(summary?.last)} />
        <Stat label="Low" value={money(summary?.low)} />
        <Stat label="High" value={money(summary?.high)} />
        <Stat label="Qty sold" value={String(summary?.qtySold ?? 0)} />
        {data.costVisible && (
          <Stat label="Avg cost now" value={costCell(summary?.currentAvgCost ?? null)} />
        )}
        {data.costVisible && (
          <button
            type="button"
            onClick={() => setShowCost((v) => !v)}
            aria-pressed={showCost}
            className="ml-auto flex items-center gap-1 text-[11px] text-navy/60 hover:text-navy"
          >
            {showCost ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showCost ? "Hide cost" : "Show cost"}
          </button>
        )}
      </div>

      <table className="w-full text-left">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-navy/50">
            <th className="py-1 font-medium">Date</th>
            <th className="py-1 font-medium">Price</th>
            {data.costVisible && <th className="py-1 font-medium">Avg cost</th>}
            <th className="py-1 font-medium">Qty</th>
            <th className="py-1 font-medium">Invoice / Order</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.orderId}-${r.invoiceId ?? "o"}-${i}`}
              className="border-t border-surface-border"
            >
              <td className="py-1 pr-2 text-navy/70">{fmtDate(r.date)}</td>
              <td className="py-1 pr-2 font-mono text-navy">
                {fmt(r.unitPrice)}
                {r.priceType && PRICE_TYPE_TAG[r.priceType] && (
                  <span className="ml-1 rounded bg-sunken px-1 text-[9px] uppercase text-navy/50">
                    {PRICE_TYPE_TAG[r.priceType]}
                  </span>
                )}
              </td>
              {data.costVisible && (
                <td className="py-1 pr-2 font-mono text-navy/70">{costCell(r.avgCostAtSale)}</td>
              )}
              <td className="py-1 pr-2 text-navy/70">
                {r.qty} {r.unitLabel}
              </td>
              <td className="py-1 pr-2 text-navy/70">
                {r.source === "INVOICE" ? (
                  (r.invoiceNumber ?? r.orderNumber)
                ) : (
                  <>
                    {r.orderNumber}
                    <span className="ml-1 rounded bg-amber-50 px-1 text-[9px] text-amber-700 ring-1 ring-amber-200">
                      not invoiced yet
                    </span>
                  </>
                )}
              </td>
              <td className="py-1 text-right">
                <button
                  type="button"
                  disabled={!canUse(r)}
                  title={canUse(r) ? undefined : "A different unit than this line"}
                  aria-label={`Use this price ${fmt(r.unitPrice)}`}
                  onClick={() => onUse(r.unitPrice)}
                  className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-brand-600 ring-1 ring-brand-200 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Use this price
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({
  customerId,
  customerName,
  productId,
  productName,
  unitHint,
  anchor,
  onClose,
  onUsePrice,
}: {
  customerId: string;
  customerName?: string | null;
  productId: string;
  productName: string;
  unitHint?: string | null;
  anchor: HTMLElement;
  onClose: () => void;
  onUsePrice: (price: number) => void;
}) {
  const q = usePriceHistory(customerId, productId, true);
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} label="Price history" width={420}>
      {q.isLoading ? (
        <Skeleton />
      ) : q.isError || !q.data ? (
        <div role="alert" className="space-y-2 text-xs text-navy">
          <p>Couldn&apos;t load price history.</p>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="rounded px-2 py-1 text-[11px] font-medium text-brand-600 ring-1 ring-brand-200 hover:bg-brand-50"
          >
            Retry
          </button>
        </div>
      ) : q.data.rows.length === 0 ? (
        <div className="space-y-1 text-xs">
          <p className="text-sm font-semibold text-navy">
            Price history · {q.data.productName || productName}
          </p>
          <p className="text-navy/60">No past sales of this product to this customer</p>
        </div>
      ) : (
        <PanelBody
          data={q.data}
          productName={productName}
          customerName={customerName}
          unitHint={unitHint}
          onUse={(price) => {
            onUsePrice(price);
            onClose();
          }}
        />
      )}
    </AnchoredPopover>
  );
}

/**
 * The small clock icon beside a line's price input: opens a non-modal popover of what this customer
 * has paid for this product. Disabled until a customer and a product are chosen. Opening / closing
 * never touches the price; "Use this price" hands the number to `onUsePrice`, which MUST be the
 * line's existing price-change path (special-price reason and margin-floor rules still apply).
 * On close, focus returns to the price input beside the button.
 */
export function PriceHistoryButton({
  customerId,
  customerName,
  productId,
  productName,
  unitHint,
  onUsePrice,
  focusSelector,
  className,
}: {
  customerId?: string | null;
  customerName?: string | null;
  productId?: string | null;
  productName: string;
  /** The unit being entered (case / piece / ...), so history and "Use" never cross units. */
  unitHint?: string | null;
  onUsePrice: (price: number) => void;
  /** The price input to refocus on close (searched within the row / container); defaults to the first input beside the button. */
  focusSelector?: string;
  className?: string;
}) {
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const ready = !!customerId && !!productId;

  const close = React.useCallback(() => {
    setOpen(false);
    // Deferred a tick: "Use this price" has just changed the line's price, and the price input keeps
    // the draft it had when it GAINED focus — focusing it before that render shows the stale price.
    setTimeout(() => {
      const scope = focusSelector ? anchor?.closest("li") : anchor?.parentElement;
      const input = scope?.querySelector<HTMLElement>(focusSelector ?? "input");
      (input ?? anchor)?.focus();
    }, 0);
  }, [anchor, focusSelector]);

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        disabled={!ready}
        aria-label="Price history"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={ready ? "Price history" : "Choose a customer and a product first"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-navy/60 hover:bg-sunken hover:text-navy disabled:cursor-not-allowed disabled:opacity-40",
          className,
        )}
      >
        <History className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && ready && anchor && (
        <Panel
          customerId={customerId!}
          customerName={customerName}
          productId={productId!}
          productName={productName}
          unitHint={unitHint}
          anchor={anchor}
          onClose={close}
          onUsePrice={onUsePrice}
        />
      )}
    </>
  );
}
