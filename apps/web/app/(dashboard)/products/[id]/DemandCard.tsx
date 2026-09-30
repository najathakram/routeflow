"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@routeflow/ui/web";
import {
  type DemandGranularity,
  type DemandRange,
  useProductDemand,
} from "@/lib/api/product-demand";
import { unitsLabel } from "@/lib/stock-label";

/**
 * Real per-product demand, from invoiced sales. Replaces a seeded-PRNG demo chart.
 *
 * Lives in its own file (unlike the inline CostHistoryCard next to it) because it owns
 * range + metric state, per-granularity label formatting and five render states —
 * page.tsx is already ~2.7k lines.
 */

type Metric = "units" | "revenue";

const RANGE_OPTIONS = [
  { value: "30d" as const, label: "30D", aria: "Last 30 days", noun: "30 days" },
  { value: "6m" as const, label: "6M", aria: "Last 6 months", noun: "6 months" },
  { value: "1y" as const, label: "1Y", aria: "Last year", noun: "year" },
  { value: "5y" as const, label: "5Y", aria: "Last 5 years", noun: "5 years" },
];

const METRIC_OPTIONS = [
  { value: "units" as const, label: "Units", aria: "Show units sold" },
  { value: "revenue" as const, label: "Revenue", aria: "Show revenue" },
];

/**
 * GUARANTEED reach of each range in days — the minimum distance back the server's
 * window extends, whatever "today" is. Deliberately conservative: the server anchors
 * 6m to Mondays (reach 175–181d) and 1y/5y to calendar months (334–365d / ~1795–1825d),
 * so using the MINIMUM means a suggested range always actually contains the sale.
 * Optimistic values (182/365/1826) can suggest a window the sale falls just outside,
 * landing the operator on another empty chart with no further suggestion.
 */
const RANGE_REACH_DAYS: Record<DemandRange, number> = {
  "30d": 29,
  "6m": 175,
  "1y": 334,
  "5y": 1795,
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Calendar parts of a "YYYY-MM-DD" bucket key. Never `new Date(iso)` — a date-only
 * string parses as UTC midnight, which renders as the PREVIOUS day for any tenant west
 * of UTC (the same trap DateRangePicker documents).
 */
function parts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function axisLabel(iso: string, granularity: DemandGranularity): string {
  const { y, m, d } = parts(iso);
  if (granularity === "month") return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
  return `${m}/${d}`;
}

function tipLabel(iso: string, granularity: DemandGranularity): string {
  const { y, m, d } = parts(iso);
  if (granularity === "month") return `${MONTHS[m - 1]} ${y}`;
  if (granularity === "week") return `Week of ${MONTHS[m - 1]} ${d}`;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function monthYear(iso: string): string {
  const { y, m } = parts(iso);
  return `${MONTHS[m - 1]} ${y}`;
}

/**
 * Recharts `interval` (labels every n+1 ticks) targeting ~10 x-axis labels.
 * Derived from the BUCKET COUNT, not the granularity: 1Y and 5Y are both monthly but
 * 12 vs 60 points, and a fixed per-granularity value renders all 60 labels on 5Y.
 */
function tickInterval(count: number): number {
  if (count <= 12) return 0;
  return Math.ceil(count / 10) - 1;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  groupLabel,
}: {
  options: readonly { value: T; label: string; aria: string }[];
  value: T;
  onChange: (v: T) => void;
  groupLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="flex items-center rounded-lg border border-surface-border bg-surface-raised p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-label={opt.aria}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
            value === opt.value
              ? "bg-white text-brand-600 shadow-sm"
              : "text-navy/70 hover:text-navy"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function DemandCard({
  productId,
  unitsPerBox,
}: {
  productId: string;
  unitsPerBox?: number | null;
}) {
  // Default 6M, not 30D: most products with sales have no activity in any given 30-day
  // window, so a 30D default would greet the majority with an empty state.
  const [range, setRange] = React.useState<DemandRange>("6m");
  const [metric, setMetric] = React.useState<Metric>("units");
  const { data, isLoading, isError, isFetching, refetch } = useProductDemand(productId, range);

  // Everything DISPLAYED derives from the payload's own range, not the clicked state:
  // with keepPreviousData a range switch shows the OLD payload until the new one lands,
  // and pairing old totals with the new range's noun would assert e.g. "147 pcs over
  // the last 5 years" for the whole fetch. The pills still reflect `range` (instant
  // feedback); the isFetching opacity marks the body as stale meanwhile.
  const shownRange = data?.range ?? range;
  const rangeNoun = RANGE_OPTIONS.find((o) => o.value === shownRange)!.noun;
  const neverSold = !!data && !data.hasAnySales;
  const emptyWindow = !!data && data.hasAnySales && data.totals.units === 0;

  // Smallest range GUARANTEED to reach the last sale — powers the one-click recovery
  // from an empty window instead of making the operator try each pill.
  const suggested = React.useMemo<DemandRange | null>(() => {
    if (!data?.lastSaleAt) return null;
    const { y, m, d } = parts(data.lastSaleAt);
    const ageDays = (Date.now() - Date.UTC(y, m - 1, d)) / 86_400_000;
    const fit = RANGE_OPTIONS.find((o) => RANGE_REACH_DAYS[o.value] > ageDays);
    return fit && fit.value !== shownRange ? fit.value : null;
  }, [data?.lastSaleAt, shownRange]);

  const chartData = React.useMemo(
    () =>
      (data?.buckets ?? []).map((b) => ({
        axis: axisLabel(b.date, data!.granularity),
        tip: tipLabel(b.date, data!.granularity),
        units: b.units,
        revenue: b.revenue,
      })),
    [data],
  );

  const showControls = !!data && !neverSold;

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-5 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Sales Demand
        </h3>
        {showControls && (
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              options={RANGE_OPTIONS}
              value={range}
              onChange={setRange}
              groupLabel="Demand range"
            />
            <Segmented
              options={METRIC_OPTIONS}
              value={metric}
              onChange={setMetric}
              groupLabel="Demand metric"
            />
          </div>
        )}
      </div>

      <div className="p-5">
        {isLoading ? (
          <Skeleton shape="block" height={200} />
        ) : isError ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-2">
            <p className="text-sm text-navy/70">Couldn&apos;t load demand.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Try again
            </button>
          </div>
        ) : neverSold ? (
          // Terminal — no range or metric can change this answer, so it costs less
          // vertical space and the controls are hidden rather than left inert.
          <div className="flex h-[120px] flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm font-medium text-navy">Never sold</p>
            <p className="text-xs text-navy/70">This product has not appeared on an invoice yet.</p>
          </div>
        ) : emptyWindow ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-navy/70">No sales in the last {rangeNoun}.</p>
            {data?.lastSaleAt && (
              <>
                <p className="text-xs text-navy/60">Last sold {monthYear(data.lastSaleAt)}.</p>
                {suggested && (
                  <button
                    type="button"
                    onClick={() => setRange(suggested)}
                    className="text-xs font-medium text-brand-600 hover:text-brand-700"
                  >
                    View {RANGE_OPTIONS.find((o) => o.value === suggested)!.aria.toLowerCase()}
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          data && (
            <>
              <p className="mb-3 text-xs text-navy/70">
                {metric === "revenue"
                  ? `${money.format(data.totals.revenue)} invoiced`
                  : unitsLabel(data.totals.units, unitsPerBox)}{" "}
                over the last {rangeNoun} · bucketed by {data.granularity}.
              </p>
              <div className={isFetching ? "opacity-60 transition-opacity" : undefined}>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis
                      dataKey="axis"
                      interval={tickInterval(data.buckets.length)}
                      tick={{ fontSize: 10, fill: "#1B3A5C99" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 10, fill: "#1B3A5C99" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) =>
                        metric === "revenue"
                          ? v >= 1000
                            ? `$${Math.round(v / 1000)}k`
                            : `$${Math.round(v)}`
                          : v >= 1000
                            ? `${Math.round(v / 1000)}k`
                            : String(v)
                      }
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 8,
                        border: "1px solid #e2e8f0",
                        fontSize: 12,
                        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                      }}
                      labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
                      labelFormatter={
                        ((_: string, p: { payload?: { tip?: string } }[]) =>
                          p?.[0]?.payload?.tip ?? "") as any
                      }
                      formatter={
                        ((v: number) =>
                          metric === "revenue"
                            ? [money.format(Number(v)), "Net sales"]
                            : [unitsLabel(Number(v), unitsPerBox), "Sold"]) as any
                      }
                    />
                    {/* key remounts on metric switch so the bars re-enter instead of
                        tweening between a piece count and a dollar amount. */}
                    <Bar
                      key={metric}
                      dataKey={metric}
                      fill={metric === "revenue" ? "#10b981" : "#3b82f6"}
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Recharts renders nothing a screen reader can use. */}
              <p className="sr-only">
                {metric === "revenue"
                  ? `${money.format(data.totals.revenue)} of net sales`
                  : `${data.totals.units.toLocaleString("en-US")} pieces sold`}{" "}
                over the last {rangeNoun}.
              </p>
              {/* Only when at least one WHOLE leading bucket predates the first sale —
                  comparing against buckets[1].date, not buckets[0].date, because a first
                  sale mid-way through the first bucket leaves zero buckets empty. */}
              {data.firstSaleAt &&
                data.buckets.length > 1 &&
                data.firstSaleAt >= data.buckets[1].date && (
                  <p className="mt-2 text-[11px] text-navy/60">
                    Sales history starts {monthYear(data.firstSaleAt)} — earlier buckets are empty.
                  </p>
                )}
            </>
          )
        )}
      </div>
    </div>
  );
}
