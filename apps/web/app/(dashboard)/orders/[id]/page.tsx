"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  MapPin,
  User,
  Package,
  FileText,
  CheckCircle2,
  Lock,
  XCircle,
  Loader2,
} from "lucide-react";
import { Badge, Button, Card, cn, type BadgeStatus } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useOrder, useUpdateOrderStatus } from "@/lib/api/orders";

// ─── Types ────────────────────────────────────────────────────────────────────

type LocalOrderStatus = "PENDING" | "CONFIRMED" | "LOCKED" | "CANCELLED";
type ApiOrderStatus = "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED";

// ─── Status action buttons ────────────────────────────────────────────────────

function ActionButtons({
  localStatus,
  onConfirm,
  onLock,
  onCancel,
  isPending,
}: {
  localStatus: LocalOrderStatus;
  onConfirm: () => void;
  onLock: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  if (localStatus === "CANCELLED" || localStatus === "LOCKED") {
    return (
      <span className="text-sm italic text-navy/40">
        {localStatus === "CANCELLED" ? "Order is cancelled." : "No further actions available."}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {localStatus === "PENDING" && (
        <Button
          size="sm"
          leftIcon={<CheckCircle2 className="h-4 w-4" />}
          onClick={onConfirm}
          loading={isPending}
        >
          Confirm Order
        </Button>
      )}
      {(localStatus === "PENDING" || localStatus === "CONFIRMED") && (
        <>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Lock className="h-4 w-4" />}
            onClick={onLock}
            loading={isPending}
          >
            Lock Order
          </Button>
          <Button
            size="sm"
            variant="danger"
            leftIcon={<XCircle className="h-4 w-4" />}
            onClick={onCancel}
            loading={isPending}
          >
            Cancel Order
          </Button>
        </>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { data: order, isLoading, isError } = useOrder(params.id);
  const updateStatus = useUpdateOrderStatus();

  const [localStatus, setLocalStatus] = React.useState<LocalOrderStatus>("PENDING");

  React.useEffect(() => {
    if (order) {
      setTitle(order.orderNumber);
      switch (order.status) {
        case "PENDING": setLocalStatus("PENDING"); break;
        case "CONFIRMED": setLocalStatus("CONFIRMED"); break;
        case "CANCELLED": setLocalStatus("CANCELLED"); break;
        // OUT_FOR_DELIVERY and DELIVERED are read-only — treat as LOCKED
        default: setLocalStatus("LOCKED"); break;
      }
    }
  }, [order, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Order not found.</p>
        <Button variant="secondary" href="/orders">Back to Orders</Button>
      </div>
    );
  }

  const total = Number(order.total);
  const statusForBadge: ApiOrderStatus =
    localStatus === "LOCKED" ? (order.status as ApiOrderStatus) : (localStatus as ApiOrderStatus);

  const handleConfirm = () => {
    updateStatus.mutate({ id: order.id, status: "CONFIRMED" }, {
      onSuccess: () => setLocalStatus("CONFIRMED"),
    });
  };

  const handleLock = () => {
    updateStatus.mutate({ id: order.id, status: "OUT_FOR_DELIVERY" }, {
      onSuccess: () => setLocalStatus("LOCKED"),
    });
  };

  const handleCancel = () => {
    updateStatus.mutate({ id: order.id, status: "CANCELLED" }, {
      onSuccess: () => setLocalStatus("CANCELLED"),
    });
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/orders"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Orders
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {order.urgent && (
            <div className="mt-1 flex items-center gap-1.5 rounded-full bg-danger-bg px-2.5 py-1 text-xs font-semibold text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              URGENT
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-navy">{order.orderNumber}</h1>
            <p className="mt-1 text-sm text-navy/60">
              {new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge status={statusForBadge} />
          <ActionButtons
            localStatus={localStatus}
            onConfirm={handleConfirm}
            onLock={handleLock}
            onCancel={handleCancel}
            isPending={updateStatus.isPending}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">

        {/* ── Main content ── */}
        <div className="space-y-5 lg:col-span-2">

          {/* Line items */}
          <Card title="Line Items">
            <div className="-mx-6 -mb-6 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised">
                  <tr>
                    <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/60">Product</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/60">Qty</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/60">Unit Price</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/60">Total</th>
                    <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/60">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {order.lineItems.map((li) => (
                    <tr key={li.id} className="hover:bg-surface-raised">
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
                            <Package className="h-4 w-4 text-navy/30" />
                          </div>
                          <span className="font-medium text-navy">{li.product?.name ?? li.productId}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-navy/70">{li.qty}</td>
                      <td className="px-4 py-3 text-right text-navy/70">
                        ${Number(li.unitPrice).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-navy">
                        ${(li.qty * Number(li.unitPrice)).toFixed(2)}
                      </td>
                      <td className="px-6 py-3">
                        <Badge status={li.status as BadgeStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-surface-border">
                  <tr>
                    <td colSpan={3} className="px-6 py-3 text-right text-sm font-semibold text-navy">
                      Order Total
                    </td>
                    <td className="px-4 py-3 text-right text-base font-bold text-navy">
                      ${total.toFixed(2)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {/* Notes */}
          {order.notes && (
            <Card title="Order Notes">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
                <p className="text-sm text-navy/80">{order.notes}</p>
              </div>
            </Card>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="space-y-4">

          {/* Customer info */}
          <Card title="Customer">
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
                <div>
                  <p className="text-sm font-semibold text-navy">{order.customer?.businessName ?? "—"}</p>
                  {order.customer?.contactName && (
                    <p className="text-xs text-navy/50">{order.customer.contactName}</p>
                  )}
                </div>
              </div>
              <Link
                href={`/customers/${order.customerId}`}
                className="mt-1 block text-xs text-brand-500 hover:underline"
              >
                View customer profile →
              </Link>
            </div>
          </Card>

          {/* Order summary */}
          <Card title="Summary">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/60">Line items</dt>
                <dd className="font-medium text-navy">{order.lineItems.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Total qty</dt>
                <dd className="font-medium text-navy">
                  {order.lineItems.reduce((s, li) => s + li.qty, 0)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Subtotal</dt>
                <dd className="font-medium text-navy">${Number(order.subtotal).toFixed(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Tax</dt>
                <dd className="font-medium text-navy">${Number(order.tax).toFixed(2)}</dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-2">
                <dt className="font-semibold text-navy">Order total</dt>
                <dd className="font-bold text-navy">${total.toFixed(2)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
