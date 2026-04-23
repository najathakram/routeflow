"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Package,
  Clock,
  CheckCircle2,
  Truck,
  XCircle,
  AlertTriangle,
  Edit3,
  Minus,
  Plus,
  Loader2,
  Search,
  Trash2,
  FileText,
} from "lucide-react";
import { Badge, Button, Modal } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerOrder,
  useBuyerCancelOrder,
  useBuyerUpdateOrderItems,
  useBuyerProducts,
} from "@/lib/api/buyer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STEPS = ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"];

function getStatusVariant(s: string): "success" | "warning" | "danger" | "neutral" {
  if (s === "DELIVERED" || s === "COMPLETED") return "success";
  if (s === "PARTIALLY_DELIVERED") return "warning";
  if (s === "PENDING" || s === "CONFIRMED" || s === "OUT_FOR_DELIVERY") return "warning";
  if (s === "CANCELLED") return "danger";
  return "neutral";
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatStatus(s: string) {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Status Timeline ──────────────────────────────────────────────────────────

function OrderTimeline({ status }: { status: string }) {
  const isCancelled = status === "CANCELLED";
  const currentIdx = STATUS_STEPS.indexOf(status);

  const icons = [
    { icon: Clock, label: "Pending" },
    { icon: CheckCircle2, label: "Confirmed" },
    { icon: Truck, label: "Out for Delivery" },
    { icon: Package, label: "Partial Delivery" },
    { icon: CheckCircle2, label: "Delivered" },
  ];

  return (
    <div className="flex items-center justify-between gap-0">
      {icons.map((step, i) => {
        const Icon = step.icon;
        const isComplete = !isCancelled && i <= currentIdx;
        const isCurrent = !isCancelled && i === currentIdx;

        return (
          <React.Fragment key={step.label}>
            {i > 0 && (
              <div
                className={`flex-1 h-0.5 ${isComplete ? "bg-buyer-500" : "bg-surface-border"}`}
              />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors ${
                  isCurrent
                    ? "border-buyer-500 bg-buyer-50 text-buyer-600"
                    : isComplete
                      ? "border-buyer-500 bg-buyer-500 text-white"
                      : "border-surface-border bg-white text-navy/30"
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <span
                className={`text-[10px] font-medium ${isCurrent ? "text-buyer-600" : isComplete ? "text-navy" : "text-navy/40"}`}
              >
                {step.label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
      {isCancelled && (
        <div className="flex flex-col items-center gap-1 ml-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-danger bg-danger-bg text-danger">
            <XCircle className="h-4 w-4" />
          </div>
          <span className="text-[10px] font-medium text-danger">Cancelled</span>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;
  const orderId = params.id as string;

  const { data: order, isLoading, isError } = useBuyerOrder(orderId);
  const cancelOrder = useBuyerCancelOrder();
  const updateItems = useBuyerUpdateOrderItems();

  const [editMode, setEditMode] = React.useState(false);
  const [editItems, setEditItems] = React.useState<Array<{ productId: string; qty: number; name: string; unit: string; unitPrice: number }>>([]);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [addSearch, setAddSearch] = React.useState("");
  const [addSearchDebounced, setAddSearchDebounced] = React.useState("");

  // Debounce product search for adding items
  React.useEffect(() => {
    const t = setTimeout(() => setAddSearchDebounced(addSearch), 300);
    return () => clearTimeout(t);
  }, [addSearch]);

  const showProductSearch = editMode && addSearchDebounced.length >= 2;
  const { data: searchResults } = useBuyerProducts(
    showProductSearch ? { search: addSearchDebounced, limit: 6 } : { limit: 0 },
  );

  // Redirect checks
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  const canEdit = order && (order.status === "DRAFT" || order.status === "PENDING");
  const showDeliveryProgress = order && (order.status === "PARTIALLY_DELIVERED" || order.status === "OUT_FOR_DELIVERY" || order.status === "DELIVERED");
  const canCancel = canEdit;

  const enterEditMode = () => {
    if (!order) return;
    setActionError(null);
    setEditItems(
      order.lineItems
        .filter((li) => li.status !== "CANCELLED")
        .map((li) => ({
          productId: li.productId,
          qty: Number(li.qty),
          name: li.product.name,
          unit: li.product.unit,
          unitPrice: Number(li.unitPrice),
        })),
    );
    setEditMode(true);
  };

  const handleSaveEdit = async () => {
    if (!order) return;
    setActionError(null);
    try {
      await updateItems.mutateAsync({
        orderId: order.id,
        items: editItems.map((i) => ({ productId: i.productId, qty: i.qty })),
      });
      setEditMode(false);
    } catch (err: any) {
      setActionError(err?.response?.data?.message ?? "Failed to update order items.");
    }
  };

  const handleCancel = async () => {
    if (!order) return;
    setActionError(null);
    try {
      await cancelOrder.mutateAsync(order.id);
      setCancelOpen(false);
    } catch (err: any) {
      setCancelOpen(false);
      setActionError(err?.response?.data?.message ?? "Failed to cancel order.");
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          Failed to load order.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Back + header */}
      <button
        onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders`)}
        className="mb-4 flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Orders
      </button>

      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy">{order.orderNumber}</h1>
          <p className="text-sm text-navy/60 mt-0.5">
            Placed {formatDate(order.createdAt)}
            {order.requestedDeliveryDate && (
              <> · Delivery requested {formatDate(order.requestedDeliveryDate)}</>
            )}
          </p>
        </div>
        <Badge variant={getStatusVariant(order.status)}>{formatStatus(order.status)}</Badge>
      </div>

      {/* Status timeline */}
      <div className="mb-8 rounded-xl border border-surface-border bg-white p-6">
        <OrderTimeline status={order.status} />
      </div>

      {/* Order summary cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Subtotal", value: fmt(Number(order.subtotal)) },
          { label: "Tax", value: fmt(Number(order.tax)) },
          {
            label: "Discount",
            value: Number(order.discountAmount) > 0 ? `-${fmt(Number(order.discountAmount))}` : fmt(0),
          },
          { label: "Total", value: fmt(Number(order.total)), bold: true },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-surface-border bg-white p-4">
            <p className="text-xs text-navy/50 mb-1">{c.label}</p>
            <p className={`text-lg ${c.bold ? "font-bold text-navy" : "text-navy/80"}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {order.urgent && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-bg px-4 py-2.5 text-sm text-warning">
          <AlertTriangle className="h-4 w-4" /> This order is marked as urgent
        </div>
      )}

      {order.notes && (
        <div className="mb-4 rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs text-navy/50 mb-1">Order Notes</p>
          <p className="text-sm text-navy">{order.notes}</p>
        </div>
      )}

      {/* Action error */}
      {actionError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-danger-bg px-4 py-2.5 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {actionError}
        </div>
      )}

      {/* Line items */}
      <div className="rounded-xl border border-surface-border bg-white overflow-hidden mb-6">
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-raised px-4 py-3">
          <h2 className="text-sm font-semibold text-navy">
            Items ({order.lineItems.filter((li) => li.status !== "CANCELLED").length})
          </h2>
          {canEdit && !editMode && (
            <Button variant="secondary" size="sm" onClick={enterEditMode}>
              <Edit3 className="mr-1.5 h-3.5 w-3.5" /> Edit Items
            </Button>
          )}
          {editMode && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditMode(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
                onClick={handleSaveEdit}
                loading={updateItems.isPending}
              >
                Save Changes
              </Button>
            </div>
          )}
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-border text-xs text-navy/50 uppercase tracking-wider">
              <th className="px-4 py-2.5 text-left">Product</th>
              <th className="px-4 py-2.5 text-right w-20">{showDeliveryProgress ? "Ordered" : "Qty"}</th>
              {showDeliveryProgress && (
                <>
                  <th className="px-4 py-2.5 text-right w-20">Delivered</th>
                  <th className="px-4 py-2.5 text-right w-20">Remaining</th>
                </>
              )}
              <th className="px-4 py-2.5 text-right w-28">Unit Price</th>
              <th className="px-4 py-2.5 text-right w-28">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {editMode
              ? editItems.map((item) => (
                  <tr key={item.productId} className="hover:bg-surface-raised/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() =>
                            setEditItems((prev) => prev.filter((i) => i.productId !== item.productId))
                          }
                          className="rounded p-1 text-danger/40 hover:bg-danger-bg hover:text-danger transition-colors"
                          title="Remove item"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-sm font-medium text-navy">{item.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() =>
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.productId === item.productId
                                  ? { ...i, qty: Math.max(1, i.qty - 1) }
                                  : i,
                              ),
                            )
                          }
                          className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={item.qty}
                          onChange={(e) => {
                            const v = Math.max(1, Number(e.target.value));
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.productId === item.productId ? { ...i, qty: v } : i,
                              ),
                            );
                          }}
                          className="w-14 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                        />
                        <button
                          onClick={() =>
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.productId === item.productId ? { ...i, qty: i.qty + 1 } : i,
                              ),
                            )
                          }
                          className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-navy/70">{item.unitPrice ? fmt(item.unitPrice) : "—"}</td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-navy">{item.unitPrice ? fmt(item.unitPrice * item.qty) : "—"}</td>
                  </tr>
                ))
              : order.lineItems.map((li) => (
                  <tr
                    key={li.id}
                    className={`hover:bg-surface-raised/50 ${li.status === "CANCELLED" ? "opacity-40 line-through" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-navy">{li.product.name}</p>
                      <p className="text-xs text-navy/50">
                        {li.product.unit}
                        {li.priceType !== "STANDARD" && (
                          <span
                            className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              li.priceType === "DISCOUNTED"
                                ? "bg-success-bg text-success"
                                : "bg-buyer-50 text-buyer-600"
                            }`}
                          >
                            {li.priceType === "DISCOUNTED" ? "Discounted" : "Special"}
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-navy">
                      <span>{Number(li.qty)}</span>
                      {li.boxes != null && li.boxes > 0 && (
                        <p className="text-[10px] text-navy/40">
                          {li.boxes} box{li.boxes > 1 ? "es" : ""}{li.pieces ? ` + ${li.pieces} pcs` : ""}
                        </p>
                      )}
                    </td>
                    {showDeliveryProgress && (
                      <>
                        <td className="px-4 py-3 text-right text-sm text-success font-medium">
                          {Number(li.deliveredQty ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm">
                          {(() => {
                            const remaining = Number(li.qty) - Number(li.deliveredQty ?? 0);
                            return remaining > 0 ? (
                              <span className="text-warning font-medium">{remaining}</span>
                            ) : (
                              <span className="text-success">0</span>
                            );
                          })()}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-3 text-right text-sm text-navy/70">
                      {fmt(Number(li.unitPrice))}
                      {li.originalPrice && Number(li.originalPrice) > Number(li.unitPrice) && (
                        <span className="ml-1 text-xs text-navy/40 line-through">
                          {fmt(Number(li.originalPrice))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                      {fmt(Number(li.subtotal))}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>

        {/* Inline product search (edit mode only) */}
        {editMode && (
          <div className="border-t border-surface-border p-4 bg-surface-raised/30">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-navy/30" />
              <input
                type="text"
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder="Search products to add (name, SKU, barcode)..."
                className="w-full rounded-lg border border-surface-border bg-white py-2 pl-10 pr-4 text-sm text-navy placeholder:text-navy/40 focus:border-buyer-300 focus:outline-none focus:ring-1 focus:ring-buyer-200"
              />
            </div>
            {showProductSearch && searchResults?.data && searchResults.data.length > 0 && (
              <div className="mt-2 rounded-lg border border-surface-border bg-white shadow-lg max-h-48 overflow-y-auto">
                {searchResults.data
                  .filter((p) => !editItems.some((ei) => ei.productId === p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setEditItems((prev) => [
                          ...prev,
                          { productId: p.id, qty: 1, name: p.name, unit: p.unit, unitPrice: p.buyerPrice },
                        ]);
                        setAddSearch("");
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-raised transition-colors border-b border-surface-border last:border-b-0"
                    >
                      <Plus className="h-4 w-4 text-buyer-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-navy truncate">{p.name}</p>
                        <p className="text-[11px] text-navy/50">
                          {p.sku ? `SKU: ${p.sku} · ` : ""}
                          {p.unit} · {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(p.buyerPrice)}
                        </p>
                      </div>
                    </button>
                  ))}
                {searchResults.data.every((p) => editItems.some((ei) => ei.productId === p.id)) && (
                  <p className="px-3 py-2 text-xs text-navy/50 text-center">All results already in order</p>
                )}
              </div>
            )}
            {showProductSearch && searchResults?.data?.length === 0 && (
              <p className="mt-2 text-xs text-navy/50 text-center py-2">No products found</p>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {canCancel && (
        <div className="flex justify-end">
          <Button variant="danger" onClick={() => setCancelOpen(true)}>
            Cancel Order
          </Button>
        </div>
      )}

      {/* Cancel confirmation */}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel Order?"
        description={`Cancel order ${order.orderNumber}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep Order
            </Button>
            <Button variant="danger" onClick={handleCancel} loading={cancelOrder.isPending}>
              Cancel Order
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          This will cancel your order <strong>{order.orderNumber}</strong>. This action cannot be
          undone.
        </p>
      </Modal>
    </div>
  );
}
