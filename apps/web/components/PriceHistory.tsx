"use client";

import * as React from "react";
import { Eye, EyeOff, History } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { AnchoredPopover } from "@/components/AnchoredPopover";
import {
  useAutoFetchSlot,
  usePrefetchPriceHistory,
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

/**
 * May this history row's price be written onto a line? Fails CLOSED: the unit must match AND, when
 * both sides know a pack size, so must the pack (a 12-pack "case" price is wrong by 2x on a line
 * that is a 24-pack case after a repack). A line with no unit hint can only use a price when the
 * history spans a single unit.
 */
export function canUseHistoryPrice(
  row: Pick<PriceHistoryRow, "unitLabel" | "unitsPerBox">,
  unitHint: string | null | undefined,
  packHint: number | null | undefined,
  unitCount: number,
): boolean {
  if (!unitHint) {
    // No unit hint: a single-unit history is the only usable one, and it must ALSO be the same
    // pack. Unknown (null) and 1 both mean "one piece"; a pack > 1 on only one side fails closed.
    if (unitCount > 1) return false;
    return (row.unitsPerBox ?? 1) === (packHint ?? 1);
  }
  if (!sameUnit(row.unitLabel, unitHint)) return false;
  const rowPack = row.unitsPerBox ?? null;
  const lineUnitsPerBox = packHint ?? null;
  return rowPack == null || lineUnitsPerBox == null || rowPack === lineUnitsPerBox;
}

const PRICE_TYPE_TAG: Record<string, string> = {
  SPECIAL: "Special",
  DISCOUNTED: "Discount",
  MANUAL: "Override",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(new Date(iso).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Inline-SVG sparkline of unit price over time (oldest -> newest); special / discount / override sales get a marker. */
function Sparkline({ points }: { points: { price: number; type: string | null }[] }) {
  if (points.length < 2) return null;
  const w = 220;
  const h = 36;
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const xy = points.map((p, i) => ({
    x: (i / (points.length - 1)) * (w - 8) + 4,
    y: h - 4 - ((p.price - lo) / span) * (h - 8),
    type: p.type,
  }));
  const last = xy[xy.length - 1]!;
  return (
    <svg
      role="img"
      aria-label={`Price trend, ${points.length} sales`}
      viewBox={`0 0 ${w} ${h}`}
      className="h-9 w-full text-brand-500"
    >
      <polyline
        points={xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {xy.map(
        (p, i) =>
          p.type &&
          PRICE_TYPE_TAG[p.type] && (
            <circle
              key={i}
              data-testid="price-marker"
              cx={p.x}
              cy={p.y}
              r="3"
              fill="white"
              stroke={p.type === "SPECIAL" ? "#059669" : "#d97706"}
              strokeWidth="1.5"
            />
          ),
      )}
      <circle cx={last.x} cy={last.y} r="2.5" fill="currentColor" />
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
  packHint,
  compare,
  comparing,
  onCompareChange,
  onUse,
}: {
  data: PriceHistoryResponse;
  productName: string;
  customerName?: string | null;
  unitHint?: string | null;
  packHint?: number | null;
  /** "All customers" is selected; the Panel owns it (it adds `?compare=all` to the request). */
  compare: boolean;
  /** The comparison request is still in flight. */
  comparing: boolean;
  onCompareChange: (on: boolean) => void;
  onUse: (price: number) => void;
}) {
  const [showCost, setShowCost] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // Focus the body only once the (visible) popover shell exists; AnchoredPopover also focuses it.
  React.useEffect(() => bodyRef.current?.focus({ preventScroll: true }), []);
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
  const chronological = [...rows].reverse().map((r) => ({ price: r.unitPrice, type: r.priceType }));
  const money = (n: number | null | undefined) => (n == null ? "—" : fmt(n));
  const costCell = (n: number | null) => (showCost ? money(n) : MASK);
  const canUse = (r: PriceHistoryRow) => canUseHistoryPrice(r, unitHint, packHint, units.length);
  const marginCell = (r: PriceHistoryRow) =>
    !showCost
      ? MASK
      : r.avgCostAtSale == null || r.unitPrice <= 0
        ? "—"
        : `${Math.round(((r.unitPrice - r.avgCostAtSale) / r.unitPrice) * 100)}%`;
  const refs = data.references;
  const agg = data.aggregate && sameUnit(data.aggregate.unitLabel, unit) ? data.aggregate : null;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))),
      );
    } else if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) {
      const r = rows[Math.min(active, rows.length - 1)];
      if (r && canUse(r)) {
        e.preventDefault();
        onUse(r.unitPrice);
      }
    }
  };

  return (
    <div
      ref={bodyRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="space-y-2 text-xs outline-none"
    >
      <div>
        <p className="text-sm font-semibold text-navy">
          Price history · {data.productName || productName}
        </p>
        <p className="text-[11px] text-navy/60">Customer: {data.customerName || customerName}</p>
        {refs &&
          (refs.listPrice != null || refs.tierPrice != null || refs.changeSinceLast != null) && (
            <p className="mt-0.5 text-[11px] text-navy/60">
              {refs.listPrice != null && <>List {fmt(refs.listPrice)}</>}
              {refs.tierPrice != null && <> · Their tier price {fmt(refs.tierPrice)}</>}
              {refs.changeSinceLast != null && (
                <>
                  {" · "}
                  <span
                    className={refs.changeSinceLast > 0 ? "text-emerald-700" : "text-amber-700"}
                  >
                    {refs.changeSinceLast > 0 ? "+" : ""}
                    {(refs.changeSinceLast * 100).toFixed(0)}% since last order
                  </span>
                </>
              )}
            </p>
          )}
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

      <Sparkline points={chronological} />

      {
        <div className="flex items-center gap-1" role="group" aria-label="Compare">
          {(["This customer", "All customers"] as const).map((label) => (
            <button
              key={label}
              type="button"
              aria-pressed={(label === "All customers") === compare}
              onClick={() => onCompareChange(label === "All customers")}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1",
                (label === "All customers") === compare
                  ? "bg-brand-50 text-brand-700 ring-brand-200"
                  : "text-navy/60 ring-surface-border hover:text-navy",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
      {compare && (
        <div data-testid="compare-panel" className="rounded border border-surface-border p-2">
          {agg ? (
            <>
              <div className="flex gap-4">
                <Stat label="Low" value={money(agg.low)} />
                <Stat label="Typical" value={money(agg.median)} />
                <Stat label="High" value={money(agg.high)} />
              </div>
              <p className="mt-1 text-[10px] text-navy/50">
                Other customers, {agg.customers} in all. Names are never shown.
              </p>
            </>
          ) : comparing ? (
            <p className="text-[11px] text-navy/60">Loading comparison…</p>
          ) : (
            <p className="text-[11px] text-navy/60">No comparison available for this unit.</p>
          )}
        </div>
      )}

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
        <thead className="hidden sm:table-header-group">
          <tr className="text-[10px] uppercase tracking-wide text-navy/50">
            <th className="whitespace-nowrap py-1 font-medium">Date</th>
            <th className="whitespace-nowrap py-1 font-medium">Price</th>
            {data.costVisible && (
              <th className="hidden whitespace-nowrap py-1 font-medium sm:table-cell">Avg cost</th>
            )}
            {data.costVisible && (
              <th className="hidden whitespace-nowrap py-1 font-medium sm:table-cell">Margin</th>
            )}
            <th className="whitespace-nowrap py-1 pl-2 font-medium">Qty</th>
            <th className="py-1 font-medium">Invoice / Order</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.orderId}-${r.invoiceId ?? "o"}-${i}`}
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-surface-border py-1 sm:table-row sm:py-0",
                i === active && "bg-brand-50/60",
              )}
            >
              <td className="whitespace-nowrap py-1 pr-2 text-navy/70">{fmtDate(r.date)}</td>
              <td className="py-1 pr-2 font-mono text-navy">
                {fmt(r.unitPrice)}
                {r.priceType && PRICE_TYPE_TAG[r.priceType] && (
                  <span className="ml-1 rounded bg-sunken px-1 text-[11px] uppercase text-navy/60">
                    {PRICE_TYPE_TAG[r.priceType]}
                  </span>
                )}
              </td>
              {data.costVisible && (
                <td className="hidden py-1 pr-2 font-mono text-navy/70 sm:table-cell">
                  {costCell(r.avgCostAtSale)}
                </td>
              )}
              {data.costVisible && (
                <td className="hidden py-1 pr-2 font-mono text-navy/70 sm:table-cell">
                  {marginCell(r)}
                </td>
              )}
              <td className="whitespace-nowrap py-1 pl-2 pr-2 text-navy/70">
                {r.qty} {r.unitLabel}
              </td>
              <td
                className="max-w-[7rem] truncate py-1 pr-2 text-navy/70"
                title={
                  r.source === "INVOICE"
                    ? (r.invoiceNumber ?? r.orderNumber)
                    : `${r.orderNumber} (not invoiced yet)`
                }
              >
                {r.source === "INVOICE" ? (
                  (r.invoiceNumber ?? r.orderNumber)
                ) : (
                  <>
                    {r.orderNumber}
                    <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700 ring-1 ring-amber-200">
                      not invoiced yet
                    </span>
                  </>
                )}
              </td>
              <td className="w-full py-1 text-right sm:w-auto">
                <button
                  type="button"
                  disabled={!canUse(r)}
                  title={canUse(r) ? undefined : "A different unit than this line"}
                  aria-label={`Use this price (${fmt(r.unitPrice)})`}
                  onClick={() => onUse(r.unitPrice)}
                  className="min-h-[44px] w-full whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-brand-600 ring-1 ring-brand-200 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:w-auto"
                >
                  <span className="sm:hidden">Use</span>
                  <span className="hidden sm:inline">Use this price</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CloseReason = "use" | "escape" | "outside";

function Panel({
  customerId,
  customerName,
  productId,
  productName,
  unitHint,
  packHint,
  anchor,
  onClose,
  onUsePrice,
}: {
  customerId: string;
  customerName?: string | null;
  productId: string;
  productName: string;
  unitHint?: string | null;
  packHint?: number | null;
  anchor: HTMLElement;
  onClose: (reason: CloseReason) => void;
  onUsePrice: (price: number) => void;
}) {
  const [compare, setCompare] = React.useState(false);
  const q = usePriceHistory(customerId, productId, true, 25, compare);
  return (
    <AnchoredPopover
      anchor={anchor}
      onClose={(r) => onClose(r ?? "escape")}
      label="Price history"
      width={520}
    >
      {q.isLoading ? (
        <Skeleton />
      ) : q.isError || !q.data ? (
        <div role="alert" className="space-y-2 text-xs text-navy">
          <p className="text-sm font-semibold">Price history · {productName}</p>
          <p>Couldn&apos;t load price history.</p>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="min-h-11 rounded px-2 py-1 text-[11px] font-medium text-brand-600 ring-1 ring-brand-200 hover:bg-brand-50 sm:min-h-0"
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
          packHint={packHint}
          compare={compare}
          comparing={q.isFetching}
          onCompareChange={setCompare}
          onUse={(price) => {
            onUsePrice(price);
            onClose("use");
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
 * On "Use this price" focus moves to the price input beside the button;
 * on Esc it returns to the trigger; an outside click moves no focus.
 */
export function PriceHistoryButton({
  customerId,
  customerName,
  productId,
  productName,
  unitHint,
  packHint,
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
  /** The line's pack size (units per box), so a price from a different pack is never offered. */
  packHint?: number | null;
  onUsePrice: (price: number) => void;
  /** The price input to refocus on close (searched within the row / container); defaults to the first input beside the button. */
  focusSelector?: string;
  className?: string;
}) {
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const ready = !!customerId && !!productId;
  const slot = useAutoFetchSlot(customerId, productId);
  usePrefetchPriceHistory(customerId, productId, 25, slot);

  // Alt+H from the price field (or anywhere on the line) opens the panel.
  React.useEffect(() => {
    if (!anchor || !ready) return;
    const scope =
      (focusSelector ? anchor.closest("li") : anchor.parentElement) ?? anchor.parentElement;
    if (!scope) return;
    const onKey = (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.altKey && !k.ctrlKey && !k.metaKey && k.key.toLowerCase() === "h") {
        k.preventDefault();
        setOpen(true);
      }
    };
    scope.addEventListener("keydown", onKey);
    return () => scope.removeEventListener("keydown", onKey);
  }, [anchor, ready, focusSelector]);

  const close = React.useCallback(
    (reason: CloseReason) => {
      setOpen(false);
      // An outside click leaves focus wherever the user put it (APG): never refocus the trigger.
      if (reason === "outside") return;
      // Deferred a tick: "Use this price" has just changed the line's price, and the price input keeps
      // the draft it had when it GAINED focus — focusing it before that render shows the stale price.
      setTimeout(() => {
        // Only "Use this price" moves on to the price field; Esc returns to the trigger.
        if (reason !== "use") return anchor?.focus();
        const scope = focusSelector ? anchor?.closest("li") : anchor?.parentElement;
        const input = scope?.querySelector<HTMLElement>(focusSelector ?? "input");
        (input ?? anchor)?.focus();
      }, 0);
    },
    [anchor, focusSelector],
  );

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        disabled={!ready}
        aria-label="Price history"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={ready ? "Price history (Alt+H)" : "Choose a customer and a product first"}
        onClick={() => setOpen((v) => !v)}
        // The host form (order builder) swallows every Enter; handle Enter/Space here and stop them so
        // the trigger opens by keyboard. Space's click fires on keyup in some browsers: swallow that too.
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) setOpen((v) => !v);
        }}
        onKeyUp={(e) => {
          if (e.key === " ") e.preventDefault();
        }}
        className={cn(
          "inline-flex h-6 min-h-11 w-6 min-w-11 shrink-0 items-center justify-center rounded text-navy/60 hover:bg-sunken hover:text-navy disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:min-w-0",
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
          packHint={packHint}
          anchor={anchor}
          onClose={close}
          onUsePrice={onUsePrice}
        />
      )}
    </>
  );
}

/**
 * The customer's last 3 sold prices for the line's unit as small tap-to-use chips ("$18.75 · Sep 26").
 * One cached request per customer + product, shared with the prefetch and the popover. Renders nothing while loading, on error, or
 * when there is no history; a tap is "Use this price" (the line's existing price path).
 */
export function PriceChips({
  customerId,
  productId,
  unitHint,
  packHint,
  onUsePrice,
}: {
  customerId?: string | null;
  productId?: string | null;
  unitHint?: string | null;
  packHint?: number | null;
  onUsePrice: (price: number) => void;
}) {
  const slot = useAutoFetchSlot(customerId, productId);
  const q = usePriceHistory(customerId, productId, slot);
  const all = q.data?.rows ?? [];
  const unitCount = new Set(all.map((r) => r.unitLabel.trim().toLowerCase())).size;
  const rows = all
    .filter((r) => canUseHistoryPrice(r, unitHint, packHint, unitCount))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3);
  if (rows.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label="Recent prices">
      {rows.map((r, i) => (
        <button
          key={`${r.orderId}-${i}`}
          type="button"
          aria-label={`Use last price ${fmt(r.unitPrice)} from ${fmtDate(r.date)}`}
          onClick={() => onUsePrice(r.unitPrice)}
          className="min-h-11 rounded-full bg-sunken px-1.5 py-0.5 text-[10px] text-navy/70 ring-1 ring-surface-border hover:bg-brand-50 hover:text-brand-700 sm:min-h-0"
        >
          {fmt(r.unitPrice)} · {fmtDate(r.date)}
        </button>
      ))}
    </span>
  );
}
