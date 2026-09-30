"use client";

import * as React from "react";
import Link from "next/link";
import { Skeleton } from "@routeflow/ui/web";
import { fmt, fmtCalendarDate } from "@/lib/formatting";
import { formatQtySplit } from "@routeflow/pricing";
import { SortableTh } from "@/components/SortableTh";
import { useSortableData } from "@/lib/use-sortable-data";
import { useProductSales, type ProductSaleLine } from "@/lib/api/product-sales";

/**
 * PR-B — "who bought this, when, at what price". Own file (DemandCard /
 * CostHistoryCard pattern) since it owns sort state + a full table and
 * page.tsx is already ~2.7k lines.
 */

function SummaryChip({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2"
      title={hint}
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-navy/60">
        {label}
        {hint && (
          <span aria-hidden className="ml-1 cursor-help text-navy/40">
            ⓘ
          </span>
        )}
      </p>
      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-navy">{value}</p>
    </div>
  );
}

export function SalesHistoryCard({ productId }: { productId: string }) {
  const { data, isLoading, isError, refetch } = useProductSales(productId);
  const lines = data?.lines ?? [];

  const { sorted, sortKey, sortDir, requestSort } = useSortableData<ProductSaleLine>(lines, {
    defaultKey: "date",
    defaultDir: "desc",
    comparators: {
      date: (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      customer: (a, b) => a.customerName.localeCompare(b.customerName),
      qty: (a, b) => a.qty - b.qty,
      unitPrice: (a, b) => a.unitPrice - b.unitPrice,
      lineTotal: (a, b) => a.lineTotal - b.lineTotal,
    },
  });

  const neverSold = !!data && data.summary.count === 0;

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="border-b border-surface-border px-5 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Sales
        </h3>
      </div>
      <div className="p-5">
        {isLoading ? (
          <Skeleton shape="block" height={160} />
        ) : isError ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-2">
            <p className="text-sm text-navy/70">Couldn&apos;t load sales history.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Try again
            </button>
          </div>
        ) : neverSold ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-navy">Never sold</p>
            <p className="text-xs text-navy/70">
              This product hasn&apos;t appeared on an invoice yet.
            </p>
            <Link
              href="/orders?action=new"
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Create an order with this product →
            </Link>
          </div>
        ) : (
          data && (
            <>
              {/* Summary chips — avg is revenue-weighted, not a plain mean of
                  the unit prices in the table below (see the ⓘ hint). */}
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <SummaryChip label="Buyers" value={data.summary.buyers.toLocaleString("en-US")} />
                <SummaryChip
                  label="Total qty"
                  value={data.summary.totalQty.toLocaleString("en-US")}
                />
                <SummaryChip label="Total revenue" value={fmt(data.summary.totalRevenue)} />
                <SummaryChip
                  label="Min price"
                  value={data.summary.minPrice != null ? fmt(data.summary.minPrice) : "—"}
                />
                <SummaryChip
                  label="Avg price"
                  value={data.summary.avgPrice != null ? fmt(data.summary.avgPrice) : "—"}
                  hint="Revenue-weighted: total revenue ÷ total qty — not a plain average of the unit prices below, so a 100-unit sale moves it more than a 1-unit sale."
                />
                <SummaryChip
                  label="Max price"
                  value={data.summary.maxPrice != null ? fmt(data.summary.maxPrice) : "—"}
                />
              </div>

              <div className="overflow-x-auto rounded-lg border border-surface-border">
                <table className="w-full text-sm">
                  <thead className="border-b border-surface-border bg-surface-raised">
                    <tr>
                      <SortableTh
                        name="date"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70"
                      >
                        Date
                      </SortableTh>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70">
                        Order #
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70">
                        Invoice #
                      </th>
                      <SortableTh
                        name="customer"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70"
                      >
                        Customer
                      </SortableTh>
                      <SortableTh
                        name="qty"
                        align="right"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70"
                      >
                        Qty
                      </SortableTh>
                      <SortableTh
                        name="unitPrice"
                        align="right"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70"
                      >
                        Unit Price
                      </SortableTh>
                      <SortableTh
                        name="lineTotal"
                        align="right"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70"
                      >
                        Line Total
                      </SortableTh>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border bg-white">
                    {sorted.map((l, i) => (
                      <tr key={`${l.invoiceId}-${i}`}>
                        <td className="px-3 py-2 text-navy/70">{fmtCalendarDate(l.date)}</td>
                        <td className="px-3 py-2">
                          {l.orderId ? (
                            <Link
                              href={`/orders/${l.orderId}`}
                              className="font-mono text-xs font-medium text-brand-600 hover:underline"
                            >
                              {l.orderNumber ?? "View"}
                            </Link>
                          ) : (
                            <span className="text-navy/30" title="Invoiced directly, no order">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/invoices/${l.invoiceId}`}
                            className="font-mono text-xs font-medium text-brand-600 hover:underline"
                          >
                            {l.invoiceNumber}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/customers/${l.customerId}`}
                            className="text-navy hover:underline"
                          >
                            {l.customerName}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-navy/70">
                          {formatQtySplit({ qty: l.qty, boxes: l.boxes, pieces: l.pieces })}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {l.overridden && l.originalPrice != null ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="strike text-xs">{fmt(l.originalPrice)}</span>
                              <span className="money">{fmt(l.unitPrice)}</span>
                            </span>
                          ) : (
                            <span className="money">{fmt(l.unitPrice)}</span>
                          )}
                        </td>
                        <td className="money px-3 py-2 text-right text-ink-900">
                          {fmt(l.lineTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
