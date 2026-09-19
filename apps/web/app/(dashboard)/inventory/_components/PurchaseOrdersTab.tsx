"use client";

import * as React from "react";
import { Plus, Eye, Send, PackageCheck, ChevronDown, ChevronUp } from "lucide-react";
import { Badge, Button, useToast } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import { fmtCalendarDate } from "@/lib/formatting";
import {
  usePurchaseOrders,
  usePurchaseOrder,
  useSendPurchaseOrder,
  useClosePurchaseOrder,
} from "@/lib/api/inventory";
import type { POItem, POStatus, PurchaseOrder, Supplier } from "./purchase-orders-shared";
import { CreatePOModal } from "./PurchaseOrdersCreateModal";
import { ReceivePOModal } from "./PurchaseOrdersReceiveModal";

function poStatusBadge(status: POStatus) {
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
  /** Same catalog list threaded through from the page — see ReceivePOModal. */
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
          {/* Line items */}
          <div className="rounded-lg border border-surface-border overflow-hidden bg-white">
            <table className="w-full text-xs">
              <thead className="bg-surface-raised text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                  <th className="px-3 py-2 text-right font-medium">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {(po.items ?? []).map((item: POItem) => {
                  const upb = Number(catalogById.get(item.productId)?.unitsPerBox ?? 0);
                  const isBoxed = upb > 1;
                  const ordered = Number(item.qtyOrdered ?? 0);
                  const received = Number(item.qtyReceived ?? 0);
                  return (
                    <tr key={item.id}>
                      <td className="px-3 py-2 font-medium text-navy">
                        {item.product?.name ?? catalogById.get(item.productId)?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-navy/70">
                        {isBoxed ? unitsLabel(ordered, upb) : ordered}
                      </td>
                      <td className="px-3 py-2 text-right text-navy/70">
                        ${Number(item.unitCost).toFixed(isBoxed ? 4 : 2)}
                        {isBoxed && <span className="text-navy/30"> /pc</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-navy/70">
                        {item.qtyReceived != null ? (
                          isBoxed ? (
                            unitsLabel(received, upb)
                          ) : (
                            received
                          )
                        ) : (
                          <span className="text-navy/30">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-navy/70">
                        {formatMoney(ordered * Number(item.unitCost ?? 0))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

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

export function PurchaseOrdersTab({
  suppliers,
  products,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string; unitsPerBox?: number | null }[];
}) {
  const [statusFilter, setStatusFilter] = React.useState("");
  const [supplierFilter, setSupplierFilter] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [receivePO, setReceivePO] = React.useState<PurchaseOrder | null>(null);

  const { data: poData, isLoading } = usePurchaseOrders({
    status: statusFilter || undefined,
    supplierId: supplierFilter || undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    page: 1,
    limit: 20,
  });

  const orders: PurchaseOrder[] = poData?.data ?? poData ?? [];

  const toggleExpand = (id: string) => setExpandedId((prev) => (prev === id ? null : id));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-navy">Purchase Orders</h2>
        <Button
          size="sm"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowCreateModal(true)}
        >
          Create PO
        </Button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
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
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          placeholder="From"
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          placeholder="To"
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {(statusFilter || supplierFilter || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setStatusFilter("");
              setSupplierFilter("");
              setDateFrom("");
              setDateTo("");
            }}
            className="rounded px-2 py-1.5 text-xs text-navy/70 hover:text-navy hover:bg-surface-raised"
          >
            Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-raised" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
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
                  <tr className="transition-colors hover:bg-surface-raised/40">
                    <td className="px-4 py-3 font-mono text-xs font-medium text-navy">
                      {po.poNumber}
                    </td>
                    <td className="px-4 py-3 text-navy/70">{po.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3">{poStatusBadge(po.status)}</td>
                    <td className="px-4 py-3 text-navy/70">{po.items?.length ?? 0}</td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {formatMoney(po.total ?? 0)}
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
