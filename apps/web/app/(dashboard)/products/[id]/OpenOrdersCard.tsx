"use client";

import * as React from "react";
import Link from "next/link";
import { Badge, Skeleton } from "@routeflow/ui/web";
import { fmtCalendarDate } from "@/lib/formatting";
import { formatQtySplit, invoiceLineQtyText, normalizeBoxesPieces } from "@routeflow/pricing";
import { SortableTh } from "@/components/SortableTh";
import { useSortableData } from "@/lib/use-sortable-data";
import { useProductOpenOrders, type ProductOpenOrderLine } from "@/lib/api/product-open-orders";

/**
 * "Who has this on order, and how many" — the orders that still have this product to be billed
 * (PENDING, CONFIRMED, OUT_FOR_DELIVERY; counter sales excluded). Mounted directly above the invoiced
 * Sales card, staff only. Same shell, header type and chip grid as SalesHistoryCard. No money.
 */

const TH = "px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70";

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-navy/60">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-navy">{value}</p>
    </div>
  );
}

/** A qty in base units as the line's own boxes + pieces (its pack snapshot), via the one formatter. */
function qtyText(qty: number, unitsPerBox: number | null, unitLabel: string | null): string {
  const split = normalizeBoxesPieces({ qty, unitsPerBox });
  return invoiceLineQtyText({ qty, boxes: split.boxes, pieces: split.pieces, unitLabel });
}

export function OpenOrdersCard({
  productId,
  unitsPerBox,
}: {
  productId: string;
  /** The product's pack, for the total chip. */
  unitsPerBox?: number | null;
}) {
  const { data, isLoading, isError, refetch } = useProductOpenOrders(productId);
  const lines = data?.lines ?? [];

  const { sorted, sortKey, sortDir, requestSort } = useSortableData<ProductOpenOrderLine>(lines, {
    defaultKey: "date",
    defaultDir: "desc",
    comparators: {
      date: (a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime(),
      customer: (a, b) => a.customerName.localeCompare(b.customerName),
      qty: (a, b) => a.remainingQty - b.remainingQty,
    },
  });

  const empty = !!data && data.lines.length === 0;
  const total = data ? normalizeBoxesPieces({ qty: data.summary.totalQty, unitsPerBox }) : null;

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="border-b border-surface-border px-5 py-3.5">
        <h3
          id="h-open-orders"
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70"
        >
          Open orders
        </h3>
      </div>
      <div className="p-5">
        {isLoading ? (
          <Skeleton shape="block" height={160} />
        ) : isError ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-2">
            <p className="text-sm text-navy/70">Couldn&apos;t load open orders.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Try again
            </button>
          </div>
        ) : empty ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-navy">No open orders</p>
            <p className="text-xs text-navy/70">Nobody has this product on an open order.</p>
          </div>
        ) : (
          data &&
          total && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <SummaryChip
                  label="Open orders"
                  value={data.summary.orders.toLocaleString("en-US")}
                />
                <SummaryChip
                  label="Customers"
                  value={data.summary.customers.toLocaleString("en-US")}
                />
                <SummaryChip
                  label="Total qty"
                  value={formatQtySplit({
                    qty: data.summary.totalQty,
                    boxes: total.boxes,
                    pieces: total.pieces,
                  })}
                />
              </div>

              <div className="overflow-x-auto rounded-lg border border-surface-border">
                <table className="w-full text-sm">
                  <thead className="border-b border-surface-border bg-surface-raised">
                    <tr>
                      <SortableTh
                        name="customer"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className={TH}
                      >
                        Customer
                      </SortableTh>
                      <th className={`${TH} text-left`}>Order #</th>
                      <SortableTh
                        name="qty"
                        align="right"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className={TH}
                      >
                        Qty to bill
                      </SortableTh>
                      <th className={`${TH} text-left`}>Status</th>
                      <SortableTh
                        name="date"
                        current={sortKey}
                        dir={sortDir}
                        onSort={requestSort}
                        className={TH}
                      >
                        Date
                      </SortableTh>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border bg-white">
                    {sorted.map((l, i) => (
                      <tr key={`${l.orderId}-${i}`}>
                        <td className="px-3 py-2">
                          <Link
                            href={`/customers/${l.customerId}`}
                            className="text-navy hover:underline"
                          >
                            {l.customerName}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/orders/${l.orderId}`}
                            className="font-mono text-xs font-medium text-brand-600 hover:underline"
                            aria-label={l.orderNumber ?? `Order ${l.orderId.slice(0, 8)}`}
                          >
                            {l.orderNumber ?? "View"}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-navy/70">
                          <span>
                            {invoiceLineQtyText({
                              qty: l.remainingQty,
                              boxes: l.boxes,
                              pieces: l.pieces,
                              unitLabel: l.unitLabel,
                            })}
                          </span>
                          {l.qty > l.remainingQty && (
                            <span className="block text-[11px] text-navy/50">
                              of {qtyText(l.qty, l.unitsPerBox, l.unitLabel)} ordered
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge status={l.status} />
                        </td>
                        <td className="px-3 py-2 text-navy/70">{fmtCalendarDate(l.orderDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.truncated && (
                <p className="mt-2 text-xs text-navy/60">
                  Showing the newest {data.lines.length.toLocaleString("en-US")}
                </p>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
