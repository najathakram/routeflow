"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Eye, Pencil, Send, PackageCheck, ChevronDown, ChevronUp } from "lucide-react";
import { Badge, Button, EmptyState, Skeleton, useToast } from "@routeflow/ui/web";
import { poDisplayTotal } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { fmtCalendarDate } from "@/lib/formatting";
import {
  usePurchaseOrders,
  usePurchaseOrder,
  useSendPurchaseOrder,
  useClosePurchaseOrder,
} from "@/lib/api/inventory";
import type { POStatus, PurchaseOrder, Supplier } from "./purchase-orders-shared";
import { CreatePOModal } from "./PurchaseOrdersCreateModal";
import { ReceivePOModal } from "./PurchaseOrdersReceiveModal";
import { PurchaseOrdersEditModal } from "./PurchaseOrdersEditModal";
import { isEditable } from "./purchase-orders-edit";
import { PurchaseOrderReadOnlyLines } from "./PurchaseOrderReadOnlyLines";

export function poStatusBadge(status: POStatus) {
  const map: Record<
    POStatus,
    { variant: "neutral" | "info" | "warning" | "success"; label: string }
  > = {
    DRAFT: { variant: "neutral", label: "Draft" },
    SENT: { variant: "info", label: "Sent" },
    PARTIAL: { variant: "warning", label: "Partial" },
    RECEIVED: { variant: "success", label: "Received" },
    CLOSED: { variant: "neutral", label: "Closed" },
  };
  const cfg = map[status] ?? { variant: "neutral", label: status };
  return <Badge variant={cfg.variant} label={cfg.label} />;
}

// ─── PO Detail Row ────────────────────────────────────────────────────────────

function PODetailRow({
  poId,
  products,
  onReceive,
}: {
  poId: string;
  /** Same catalog list threaded through from the page — see ReceivePOModal (PurchaseOrdersReceiveModal.tsx). */
  products: { id: string; name?: string; unitsPerBox?: number | null }[];
  onReceive: (po: PurchaseOrder) => void;
}) {
  const { data: po, isLoading } = usePurchaseOrder(poId);
  const sendPO = useSendPurchaseOrder();
  const closePO = useClosePurchaseOrder();
  const { toast } = useToast();
  const catalogById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  if (isLoading) {
    return (
      <tr>
        <td colSpan={8} className="px-6 py-4 text-center text-xs text-navy/70">
          Loading details…
        </td>
      </tr>
    );
  }

  if (!po) return null;

  return (
    <tr>
      <td colSpan={8} className="px-6 py-4 bg-surface-raised/40">
        <div className="space-y-3">
          <PurchaseOrderReadOnlyLines items={po.items ?? []} catalogById={catalogById} />

          {/* Notes */}
          {po.notes && (
            <p className="text-xs text-navy/70">
              <span className="font-medium">Notes:</span> {po.notes}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {po.status === "DRAFT" && (
              <Button
                size="sm"
                variant="secondary"
                loading={sendPO.isPending}
                onClick={() =>
                  sendPO.mutate(po.id, {
                    onSuccess: () => toast({ title: "PO sent.", variant: "success" }),
                    onError: () => toast({ title: "Failed to send PO.", variant: "error" }),
                  })
                }
              >
                <Send className="h-3 w-3 mr-1" /> Send
              </Button>
            )}
            {(po.status === "SENT" || po.status === "PARTIAL") && (
              <Button size="sm" variant="secondary" onClick={() => onReceive(po as PurchaseOrder)}>
                <PackageCheck className="h-3 w-3 mr-1" /> Receive
              </Button>
            )}
            {(po.status === "SENT" || po.status === "PARTIAL" || po.status === "RECEIVED") && (
              <Button
                size="sm"
                variant="secondary"
                loading={closePO.isPending}
                onClick={() =>
                  closePO.mutate(po.id, {
                    onSuccess: () => toast({ title: "PO closed.", variant: "success" }),
                    onError: () => toast({ title: "Failed to close PO.", variant: "error" }),
                  })
                }
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

const PAGE_SIZE = 20;

export function PurchaseOrdersTab({
  suppliers,
  products,
  headerExtra,
  highlightId,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string; unitsPerBox?: number | null }[];
  /** Extra header action(s), rendered before "New purchase order". */
  headerExtra?: React.ReactNode;
  /** A PO to mark as just drafted: filters clear and the list returns to page 1 so it is on screen. */
  highlightId?: string | null;
}) {
  const [statusFilter, setStatusFilter] = React.useState("");
  const [supplierFilter, setSupplierFilter] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [receivePO, setReceivePO] = React.useState<PurchaseOrder | null>(null);
  const [editPO, setEditPO] = React.useState<PurchaseOrder | null>(null);

  const {
    data: poData,
    isLoading,
    isError,
    isFetching,
    isPlaceholderData,
    refetch,
  } = usePurchaseOrders(
    {
      status: statusFilter || undefined,
      supplierId: supplierFilter || undefined,
      from: dateFrom || undefined,
      to: dateTo || undefined,
      page,
      limit: PAGE_SIZE,
    },
    { keepPrevious: true },
  );

  // A new filter starts from page 1 in the same event, so no fetch runs on a stale page.
  const onFilter = (set: (v: string) => void, value: string) => {
    set(value);
    setPage(1);
  };

  React.useEffect(() => {
    if (!highlightId) return;
    setStatusFilter("");
    setSupplierFilter("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }, [highlightId]);

  const orders: PurchaseOrder[] = poData?.data ?? poData ?? [];
  const total: number = poData?.meta?.total ?? orders.length;
  const totalPages: number = poData?.meta?.totalPages ?? 1;
  // Rows can disappear under us (a PO removed elsewhere): never stay stranded past the last page.
  React.useEffect(() => {
    // only trust a settled response: a failed or in-flight page-2 fetch must not be 'fixed' away
    if (poData?.meta && !isFetching && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, totalPages, poData, isFetching]);

  const toggleExpand = (id: string) => setExpandedId((prev) => (prev === id ? null : id));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-navy">All purchase orders</h3>
        <div className="flex flex-wrap items-center gap-2">
          {headerExtra}
          <Button
            size="sm"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setShowCreateModal(true)}
          >
            New purchase order
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          aria-label="Status"
          value={statusFilter}
          onChange={(e) => onFilter(setStatusFilter, e.target.value)}
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Statuses</option>
          {(["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"] as POStatus[]).map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </select>

        <select
          aria-label="Supplier"
          value={supplierFilter}
          onChange={(e) => onFilter(setSupplierFilter, e.target.value)}
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-navy/70">
          From
          <input
            type="date"
            aria-label="From date"
            value={dateFrom}
            onChange={(e) => onFilter(setDateFrom, e.target.value)}
            className="w-36 rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-navy/70">
          To
          <input
            type="date"
            aria-label="To date"
            value={dateTo}
            onChange={(e) => onFilter(setDateTo, e.target.value)}
            className="w-36 rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
        {(statusFilter || supplierFilter || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setStatusFilter("");
              setSupplierFilter("");
              setDateFrom("");
              setDateTo("");
              setPage(1);
            }}
            className="rounded px-2 py-1.5 text-xs text-navy/70 hover:text-navy hover:bg-surface-raised"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Announced whenever stale rows are on screen, whether or not there is a pager. */}
      <p role="status" className={isPlaceholderData ? "mb-2 text-sm text-navy/70" : "sr-only"}>
        {isPlaceholderData ? "Updating…" : ""}
      </p>

      {isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} shape="block" height={48} />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          title="Couldn't load purchase orders."
          description="Check your connection and try again."
          action={
            <Button size="sm" variant="secondary" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      ) : orders.length === 0 && !(statusFilter || supplierFilter || dateFrom || dateTo) ? (
        <EmptyState
          title="No purchase orders yet"
          description="Create one when you place an order with a supplier."
          action={
            <Button
              size="sm"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setShowCreateModal(true)}
            >
              New purchase order
            </Button>
          }
        />
      ) : (
        <div
          aria-busy={isPlaceholderData || undefined}
          className={`overflow-x-auto rounded-xl border border-surface-border transition-opacity ${
            isPlaceholderData ? "opacity-50" : ""
          }`}
        >
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                {[
                  "PO #",
                  "Supplier",
                  "Status",
                  "Items",
                  "Total",
                  "Expected Date",
                  "Actions",
                  "",
                ].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {orders.map((po) => (
                <React.Fragment key={po.id}>
                  <tr
                    data-highlighted={po.id === highlightId ? "true" : undefined}
                    className={`transition-colors hover:bg-surface-raised/40 ${
                      po.id === highlightId ? "bg-brand-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-medium text-navy">
                      <Link
                        href={`/purchase-orders/${po.id}`}
                        className="text-brand-500 hover:underline"
                      >
                        {po.poNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy/70">{po.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3">{poStatusBadge(po.status)}</td>
                    <td className="px-4 py-3 text-navy/70">{po.items?.length ?? 0}</td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {formatMoney(poDisplayTotal(po))}
                    </td>
                    <td className="px-4 py-3 text-navy/70">
                      {po.expectedDate ? fmtCalendarDate(po.expectedDate) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleExpand(po.id)}
                          title="View details"
                          className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {isEditable(po) && (
                          <button
                            onClick={() => setEditPO(po)}
                            title="Edit"
                            className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {po.status === "DRAFT" && <SendPOButton poId={po.id} />}
                        {(po.status === "SENT" || po.status === "PARTIAL") && (
                          <button
                            onClick={() => setReceivePO(po)}
                            title="Receive"
                            className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy"
                          >
                            <PackageCheck className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      <button
                        onClick={() => toggleExpand(po.id)}
                        className="rounded p-1 text-navy/30 hover:text-navy"
                      >
                        {expandedId === po.id ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  </tr>
                  {expandedId === po.id && (
                    <PODetailRow poId={po.id} products={products} onReceive={setReceivePO} />
                  )}
                </React.Fragment>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-navy/70">
                    No purchase orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {(totalPages > 1 || page > 1) && (
        <div className="mt-3 flex items-center justify-between text-sm text-navy/70">
          <span>
            {total > 0
              ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`
              : ""}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={page <= 1 || isPlaceholderData}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous page"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= totalPages || isPlaceholderData}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreatePOModal
          suppliers={suppliers}
          products={products}
          onClose={() => setShowCreateModal(false)}
        />
      )}
      {receivePO && (
        <ReceivePOModal po={receivePO} products={products} onClose={() => setReceivePO(null)} />
      )}
      {editPO && (
        <PurchaseOrdersEditModal
          po={editPO}
          suppliers={suppliers}
          products={products}
          onClose={() => setEditPO(null)}
        />
      )}
    </>
  );
}

// Small inline component to avoid hooks-in-callback issues
function SendPOButton({ poId }: { poId: string }) {
  const sendPO = useSendPurchaseOrder();
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        sendPO.mutate(poId, {
          onSuccess: () => toast({ title: "PO sent.", variant: "success" }),
          onError: () => toast({ title: "Failed to send PO.", variant: "error" }),
        })
      }
      title="Send"
      disabled={sendPO.isPending}
      className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
    >
      <Send className="h-4 w-4" />
    </button>
  );
}
