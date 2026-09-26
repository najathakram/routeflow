"use client";

import * as React from "react";
import Link from "next/link";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download } from "lucide-react";
import { Skeleton, StatCard, cn } from "@routeflow/ui/web";
import type { ProductInsightsBuyer, ProductInsightsResponse } from "@routeflow/types";
import {
  useExportProductInsightsCsv,
  useProductInsights,
  useProductSalesLines,
} from "@/lib/api/product-insights";
import { unitsLabel } from "@/lib/stock-label";
import {
  PERIOD_PRESETS,
  type PeriodMonths,
  bucketAxisLabel,
  bucketTitle,
  fileToken,
  formatDay,
  formatMoney,
  formatMoneyShort,
  formatShare,
  localToday,
  presetFrom,
} from "./insights-format";

/**
 * #2119 (plan §B / 2105-b) — one product's sales insights on `/insights/products/[id]`, from
 * #2179's accrual-net API: KPI tiles, a trend with qty / net revenue / price views, the buyers
 * table (sortable; a row filters the lines and links to that customer's insights), the paged
 * sold lines with their badges, and CSV. Formatting only — every figure is computed
 * server-side; pieces are the canonical quantity and the current pack only labels them.
 */

type Metric = "qty" | "revenue" | "price";

const METRICS: { value: Metric; label: string; aria: string }[] = [
  { value: "qty", label: "Qty", aria: "Show pieces sold" },
  { value: "revenue", label: "Net sales", aria: "Show net sales" },
  { value: "price", label: "Price", aria: "Show average price per piece" },
];

const COLORS = { bar: "#3b82f6", credit: "#f59e0b", line: "#1B3A5C", price: "#10b981" };

type SortKey = "name" | "qtyPieces" | "lineNet" | "orders" | "avgPerPiece" | "lastDate";

function tickInterval(count: number): number {
  return count <= 12 ? 0 : Math.ceil(count / 10) - 1;
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string; aria: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center rounded-lg border border-surface-border bg-surface-raised p-0.5"
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-label={o.aria}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-[32px] rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            value === o.value
              ? "bg-white text-brand-600 shadow-sm"
              : "text-navy/70 hover:text-navy",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          {title}
        </h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

// ─── Trend ───────────────────────────────────────────────────────────────────

function TrendChart({ data, metric }: { data: ProductInsightsResponse; metric: Metric }) {
  const grain = data.window.grain;
  const upb = data.product.unitsPerBox;
  const rows = React.useMemo(
    () =>
      data.series.map((p) => ({
        axis: bucketAxisLabel(p.date, grain),
        tip: bucketTitle(p.date, grain),
        qty: p.qtyPieces,
        returned: -p.returnedQtyPieces,
        gross: p.lineGross,
        credits: -p.credits,
        net: p.lineNet,
        price: p.avgPerPiece,
      })),
    [data.series, grain],
  );
  const fmtTip = (v: number, name: string): [string, string] => {
    if (name === "qty") return [unitsLabel(v, upb), "Sold"];
    if (name === "returned") return [unitsLabel(-v, upb), "Returned"];
    if (name === "gross") return [formatMoney(v), "Line sales"];
    if (name === "credits") return [formatMoney(-v), "Credits"];
    if (name === "net") return [formatMoney(v), "Net sales"];
    return [formatMoney(v), "Avg per piece"];
  };
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart
        key={metric}
        data={rows}
        stackOffset="sign"
        margin={{ top: 4, right: 4, left: -8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis
          dataKey="axis"
          interval={tickInterval(rows.length)}
          tick={{ fontSize: 10, fill: "#1B3A5C99" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#1B3A5C99" }}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: number) =>
            metric === "qty"
              ? v >= 1000
                ? `${Math.round(v / 1000)}k`
                : String(v)
              : metric === "price"
                ? `$${v.toFixed(2)}`
                : formatMoneyShort(v)
          }
          domain={metric === "price" ? ["auto", "auto"] : undefined}
        />
        <ReferenceLine y={0} stroke="#cbd5e1" />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
          labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
          labelFormatter={
            ((_: string, p: { payload?: { tip?: string } }[]) => p?.[0]?.payload?.tip ?? "") as any
          }
          formatter={((v: number, name: string) => fmtTip(Number(v), name)) as any}
        />
        {metric === "qty" && (
          <>
            <Bar dataKey="qty" stackId="s" fill={COLORS.bar} radius={[3, 3, 0, 0]} />
            <Bar dataKey="returned" stackId="s" fill={COLORS.credit} radius={[0, 0, 3, 3]} />
          </>
        )}
        {metric === "revenue" && (
          <>
            <Bar dataKey="gross" stackId="s" fill={COLORS.bar} radius={[3, 3, 0, 0]} />
            <Bar dataKey="credits" stackId="s" fill={COLORS.credit} radius={[0, 0, 3, 3]} />
            <Line dataKey="net" stroke={COLORS.line} strokeWidth={2} dot={false} type="monotone" />
          </>
        )}
        {metric === "price" && (
          <Line
            dataKey="price"
            stroke={COLORS.price}
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
            type="monotone"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── Buyers ──────────────────────────────────────────────────────────────────

function sortBuyers(rows: ProductInsightsBuyer[], key: SortKey, dir: 1 | -1) {
  const val = (b: ProductInsightsBuyer): number | string =>
    key === "name"
      ? b.name.toLowerCase()
      : key === "lastDate"
        ? (b.lastDate ?? "")
        : ((b[key] as number | null) ?? -Infinity);
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function BuyersTable({
  data,
  selected,
  onSelect,
}: {
  data: ProductInsightsResponse;
  selected: string | null;
  onSelect: (customerId: string | null) => void;
}) {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "lineNet",
    dir: -1,
  });
  const rows = React.useMemo(
    () => sortBuyers(data.buyers, sort.key, sort.dir),
    [data.buyers, sort],
  );
  const th = (key: SortKey, label: string, className?: string) => (
    <th
      className={cn("px-2 py-2 font-medium", className)}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() =>
          setSort((s) =>
            s.key === key
              ? { key, dir: s.dir === 1 ? -1 : 1 }
              : { key, dir: key === "name" ? 1 : -1 },
          )
        }
        className="inline-flex min-h-[28px] items-center gap-1 uppercase hover:text-navy"
      >
        {label}
        {sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}
      </button>
    </th>
  );
  if (rows.length === 0) return <p className="text-sm text-navy/70">No buyers in this period.</p>;
  return (
    <>
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-surface-border text-left text-[11px] tracking-wide text-navy/60">
              {th("name", "Buyer", "pl-4")}
              {th("qtyPieces", "Pieces", "text-right")}
              {th("lineNet", "Net", "text-right")}
              {th("orders", "Orders", "hidden text-right md:table-cell")}
              {th("avgPerPiece", "Per piece", "text-right")}
              {th("lastDate", "Last", "hidden pr-4 lg:table-cell")}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr
                key={b.customerId}
                className={cn(
                  "border-b border-surface-border/60 last:border-0",
                  selected === b.customerId && "bg-brand-50",
                )}
              >
                <td className="max-w-[220px] px-4 py-2">
                  <Link
                    href={`/insights/customers/${b.customerId}`}
                    className="block truncate font-medium text-brand-600 hover:text-brand-700"
                  >
                    {b.name}
                  </Link>
                  <button
                    type="button"
                    onClick={() => onSelect(selected === b.customerId ? null : b.customerId)}
                    className="text-[11px] text-navy/60 hover:text-navy"
                    aria-pressed={selected === b.customerId}
                  >
                    {selected === b.customerId ? "Showing their lines" : "Show their lines"}
                  </button>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {b.qtyPieces.toLocaleString("en-US")}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatMoney(b.lineNet)}
                  <span className="block text-[11px] text-navy/50">{formatShare(b.share)}</span>
                </td>
                <td className="hidden px-2 py-2 text-right tabular-nums md:table-cell">
                  {b.orders}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {b.avgPerPiece != null ? formatMoney(b.avgPerPiece) : "—"}
                </td>
                <td className="hidden whitespace-nowrap px-2 py-2 pr-4 text-navy/70 lg:table-cell">
                  {b.lastDate ? formatDay(b.lastDate) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.buyersTotal > data.buyers.length && (
        <p className="mt-2 text-[11px] text-navy/50">
          Top {data.buyers.length} of {data.buyersTotal} buyers by sales.
        </p>
      )}
    </>
  );
}

// ─── Lines ───────────────────────────────────────────────────────────────────

function LinesTable({
  productId,
  window,
  customerId,
  customerName,
  onClear,
}: {
  productId: string;
  window: { from: string; to: string };
  customerId: string | null;
  customerName: string | null;
  onClear: () => void;
}) {
  const q = useProductSalesLines(productId, {
    from: window.from,
    to: window.to,
    customerId: customerId ?? undefined,
  });
  const lines = q.data?.pages.flatMap((p) => p.lines) ?? [];
  return (
    <Section
      title="Sold lines"
      action={
        customerId ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex min-h-[28px] items-center rounded-full bg-brand-50 px-2.5 text-[11px] font-medium text-brand-700"
          >
            {customerName ?? "One buyer"} ✕
          </button>
        ) : undefined
      }
    >
      {q.isLoading ? (
        <Skeleton shape="block" height={160} />
      ) : q.isError ? (
        <div className="flex flex-col items-center gap-2 py-6">
          <p className="text-sm text-navy/70">Couldn&apos;t load the lines.</p>
          <button
            type="button"
            onClick={() => q.refetch()}
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Try again
          </button>
        </div>
      ) : lines.length === 0 ? (
        <p className="text-sm text-navy/70">No lines in this period.</p>
      ) : (
        <>
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-surface-border text-left text-[11px] uppercase tracking-wide text-navy/60">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Invoice</th>
                  <th className="hidden px-2 py-2 font-medium md:table-cell">Buyer</th>
                  <th className="px-2 py-2 text-right font-medium">Qty</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium">Per piece</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.lineId} className="border-b border-surface-border/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-navy/70">
                      {formatDay(l.date.slice(0, 10))}
                    </td>
                    <td className="px-2 py-2">
                      <Link
                        href={`/invoices/${l.invoiceId}`}
                        className="font-medium text-brand-600 hover:text-brand-700"
                      >
                        {l.invoiceNumber}
                      </Link>
                      <span className="flex flex-wrap gap-1">
                        {l.writtenOff && <Badge tone="warn">Written off</Badge>}
                        {l.overridden && <Badge>Re-priced</Badge>}
                        {l.creditedAmount > 0 && (
                          <Badge tone="warn">Credited {formatMoney(l.creditedAmount)}</Badge>
                        )}
                        {l.returnedQty > 0 && (
                          <Badge tone="warn">
                            Returned {l.returnedQty.toLocaleString("en-US")}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="hidden max-w-[180px] truncate px-2 py-2 md:table-cell">
                      {l.customerName}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {l.qty.toLocaleString("en-US")}
                      {l.boxes != null && (
                        <span className="block text-[11px] text-navy/50">
                          {l.boxes} × {l.unitsPerBox ?? "?"}
                          {l.pieces ? ` + ${l.pieces}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatMoney(l.lineTotal)}
                      {l.originalPrice != null && l.overridden && (
                        <span className="block text-[11px] text-navy/50 line-through">
                          {formatMoney(l.originalPrice)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {l.perPiece != null ? formatMoney(l.perPiece) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.hasNextPage && (
            <button
              type="button"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
              className="mt-3 min-h-[32px] text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
            >
              {q.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
          <p className="mt-2 text-[11px] text-navy/50">
            Newest first. Per piece is the line total divided by its pieces; blank when an older
            line&apos;s piece count is unknown.
          </p>
        </>
      )}
    </Section>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium",
        tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-surface-raised text-navy/70",
      )}
    >
      {children}
    </span>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function ProductInsightsPanel({ productId }: { productId: string }) {
  const [months, setMonths] = React.useState<PeriodMonths>(12);
  const [metric, setMetric] = React.useState<Metric>("qty");
  const [buyer, setBuyer] = React.useState<string | null>(null);
  const from = React.useMemo(() => presetFrom(localToday(), months), [months]);
  const { data, isLoading, isError, isFetching, refetch } = useProductInsights(productId, { from });
  const exportCsv = useExportProductInsightsCsv();

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-navy/60">
        {data
          ? `${formatDay(data.window.from)} – ${formatDay(data.window.to)} · net of credits`
          : " "}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={PERIOD_PRESETS.map((p) => ({ value: p.months, label: p.label, aria: p.aria }))}
          value={months}
          onChange={(v) => {
            setMonths(v as PeriodMonths);
            setBuyer(null);
          }}
          label="Period"
        />
        <button
          type="button"
          disabled={!data || exportCsv.isPending}
          onClick={() =>
            data &&
            exportCsv.mutate({
              productId,
              from: data.window.from,
              to: data.window.to,
              customerId: buyer ?? undefined,
              filename: `product-sales-${fileToken(data.product.sku || data.product.name)}-${data.window.from}-to-${data.window.to}.csv`,
            })
          }
          className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-1 text-xs font-medium text-navy hover:bg-surface-raised disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          {exportCsv.isPending ? "Exporting…" : "Export CSV"}
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        {header}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} shape="block" height={84} />
          ))}
        </div>
        <Skeleton shape="block" height={280} />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="space-y-4">
        {header}
        <div className="flex flex-col items-center gap-2 rounded-lg border border-surface-border bg-white py-12 text-center">
          <p className="text-sm text-navy/70">Couldn&apos;t load insights.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const t = data.totals;
  const upb = data.product.unitsPerBox;
  const neverSold = t.firstSaleAt == null;
  const emptyWindow = !neverSold && t.invoices === 0 && t.attributedCredits === 0;
  const buyerName = buyer ? (data.buyers.find((b) => b.customerId === buyer)?.name ?? null) : null;

  return (
    <div className={cn("space-y-4", isFetching && "opacity-70 transition-opacity")}>
      {header}
      {!data.product.isActive && (
        <p className="rounded-md bg-surface-raised px-3 py-2 text-xs text-navy/70">
          This product is inactive. Its sales history is shown for reference.
        </p>
      )}
      {exportCsv.isError && (
        <p role="alert" className="text-xs text-danger">
          The export failed. Please try again.
        </p>
      )}

      {neverSold ? (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-surface-border bg-white py-12 text-center">
          <p className="text-sm font-medium text-navy">Never sold</p>
          <p className="text-xs text-navy/70">This product has not appeared on an invoice yet.</p>
        </div>
      ) : emptyWindow ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-surface-border bg-white py-12 text-center">
          <p className="text-sm font-medium text-navy">No sales in this period.</p>
          {t.lastSaleAt && (
            <p className="text-xs text-navy/60">Last sold {formatDay(t.lastSaleAt)}.</p>
          )}
          {months < 24 && (
            <button
              type="button"
              onClick={() => setMonths(24)}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              View the last 24 months
            </button>
          )}
        </div>
      ) : (
        <>
          {t.mixedPackSizes && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Sold in more than one pack size in this period — quantities lead with pieces.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Net sold" value={unitsLabel(t.netQtyPieces, upb)} />
            <StatCard label="Net sales" value={formatMoney(t.lineNet)} />
            <StatCard label="Buyers" value={t.buyers.toLocaleString("en-US")} />
            <StatCard label="Orders" value={t.orders.toLocaleString("en-US")} />
            <StatCard
              label="Avg per piece"
              value={data.price.avgPerPiece != null ? formatMoney(data.price.avgPerPiece) : "—"}
            />
            <StatCard
              label="Last price"
              value={data.price.last ? `${formatMoney(data.price.last.perPiece)}/pc` : "—"}
            />
          </div>
          {data.price.last && (
            <p className="-mt-2 text-[11px] text-navy/60">
              Last sold {formatDay(data.price.last.date)} to {data.price.last.customer} at{" "}
              {formatMoney(data.price.last.unitPrice)}
              {data.price.last.unitLabel ? ` per ${data.price.last.unitLabel}` : ""}.
              {data.price.minPerPiece != null && data.price.maxPerPiece != null
                ? ` Range ${formatMoney(data.price.minPerPiece)}–${formatMoney(data.price.maxPerPiece)} per piece.`
                : ""}
            </p>
          )}

          <Section
            title="Trend"
            action={
              <Segmented
                options={METRICS}
                value={metric}
                onChange={setMetric}
                label="Trend metric"
              />
            }
          >
            <TrendChart data={data} metric={metric} />
            <p className="sr-only">
              {unitsLabel(t.invoicedQtyPieces, upb)} sold and {formatMoney(t.lineNet)} net sales
              from {formatDay(data.window.from)} to {formatDay(data.window.to)}.
            </p>
            <p className="mt-2 text-[11px] text-navy/60">
              {metric === "qty"
                ? "Pieces sold (blue) and returned (amber)"
                : metric === "revenue"
                  ? "Line sales (blue), credits (amber) and net (line)"
                  : "Average price per piece"}{" "}
              · by {data.window.grain}
            </p>
          </Section>

          <Section title="Buyers">
            <BuyersTable data={data} selected={buyer} onSelect={setBuyer} />
          </Section>

          <LinesTable
            productId={productId}
            window={data.window}
            customerId={buyer}
            customerName={buyerName}
            onClear={() => setBuyer(null)}
          />

          <ul className="space-y-1 text-[11px] text-navy/50">
            <li>
              Net sales = line sales on their invoice date, less credits tied to this product&apos;s
              lines on their own date. Quantities are pieces; boxes are shown at the current pack.
            </li>
            {t.unattributedCredits > 0 && (
              <li>
                {formatMoney(t.unattributedCredits)} of credits on these invoices are not tied to a
                line, so they are not subtracted here.
              </li>
            )}
            {t.unresolvedSaleLines > 0 && (
              <li>
                {t.unresolvedSaleLines} older {t.unresolvedSaleLines === 1 ? "line" : "lines"} with
                an unknown piece count {t.unresolvedSaleLines === 1 ? "is" : "are"} in sales but not
                in pieces or prices.
              </li>
            )}
            {t.unresolvedReturnLines > 0 && (
              <li>
                {t.unresolvedReturnLines} return{" "}
                {t.unresolvedReturnLines === 1 ? "line has" : "lines have"} an unknown piece count
                and {t.unresolvedReturnLines === 1 ? "is" : "are"} not in returned pieces.
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
