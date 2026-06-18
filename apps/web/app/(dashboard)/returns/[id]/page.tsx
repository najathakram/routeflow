"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Truck,
  PackageCheck,
  RefreshCw,
  Loader2,
  Clock,
  FileText,
} from "lucide-react";
import { Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useReturn,
  useApproveReturn,
  useRejectReturn,
  useMarkReturnInTransit,
  useMarkReturnReceived,
  useProcessRefund,
  type Return,
  type ReturnStatus,
  type ReturnReason,
} from "@/lib/api/returns";
import { useCreateCreditNote } from "@/lib/api/credit-notes";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<ReturnStatus, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  APPROVED: "bg-blue-100 text-blue-700",
  IN_TRANSIT: "bg-purple-100 text-purple-700",
  RECEIVED: "bg-green-100 text-green-700",
  REFUNDED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-600",
  CANCELLED: "bg-gray-100 text-gray-500",
  PROCESSED: "bg-teal-100 text-teal-700",
};

const STATUS_LABELS: Record<ReturnStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  IN_TRANSIT: "In Transit",
  RECEIVED: "Received",
  REFUNDED: "Refunded",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  PROCESSED: "Processed",
};

function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// ─── Reason label ─────────────────────────────────────────────────────────────

const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong Item",
  EXCESS_ORDER: "Excess / Overdelivery",
  CUSTOMER_REFUSED: "Customer Refused",
  QUALITY_ISSUE: "Quality Issue",
};

// ─── Process Refund Modal ─────────────────────────────────────────────────────

function ProcessRefundModal({
  isOpen,
  onClose,
  onConfirm,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (restock: boolean) => void;
  isPending: boolean;
}) {
  const [restock, setRestock] = React.useState(false);

  React.useEffect(() => {
    if (isOpen) setRestock(false);
  }, [isOpen]);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Process Refund"
      description="Finalize this return by issuing a refund."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(restock)} loading={isPending}>
            Process Refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-navy/70">
          This will mark the return as Refunded. Make sure any credit or refund has been issued to
          the customer outside of RouteFlow.
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={restock}
            onChange={(e) => setRestock(e.target.checked)}
            className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-navy">
            Restock returned items back into inventory
          </span>
        </label>
      </div>
    </Modal>
  );
}

// ─── Confirm Action Modal ─────────────────────────────────────────────────────

function ConfirmActionModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  variant,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  variant?: "danger" | "primary";
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant={variant ?? "primary"} onClick={onConfirm} loading={isPending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">{description}</p>
    </Modal>
  );
}

// ─── Status timeline ──────────────────────────────────────────────────────────

const STATUS_ORDER: ReturnStatus[] = ["PENDING", "APPROVED", "IN_TRANSIT", "RECEIVED", "REFUNDED"];

function StatusTimeline({
  currentStatus,
  logs,
}: {
  currentStatus: ReturnStatus;
  logs?: Return["logs"];
}) {
  if (currentStatus === "REJECTED" || currentStatus === "CANCELLED") {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-red-50 px-4 py-3">
        <XCircle className="h-5 w-5 shrink-0 text-red-500" />
        <div>
          <p className="text-sm font-semibold text-red-700">
            {currentStatus === "CANCELLED" ? "Return Cancelled" : "Return Rejected"}
          </p>
          {logs && logs.length > 0 && (
            <p className="text-xs text-red-500">{fmtDateTime(logs[logs.length - 1].createdAt)}</p>
          )}
        </div>
      </div>
    );
  }

  const currentIdx = STATUS_ORDER.indexOf(currentStatus);

  return (
    <div className="space-y-3">
      {STATUS_ORDER.map((s, idx) => {
        const done = idx < currentIdx;
        const active = idx === currentIdx;
        const pending = idx > currentIdx;

        const log = logs?.find((l) => l.status === s);

        return (
          <div key={s} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                  done
                    ? "bg-green-100 text-green-600"
                    : active
                      ? "bg-brand-500 text-white"
                      : "bg-surface-raised text-navy/30",
                )}
              >
                {done ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : active ? (
                  <Clock className="h-3.5 w-3.5" />
                ) : (
                  <div className="h-2 w-2 rounded-full bg-navy/20" />
                )}
              </div>
              {idx < STATUS_ORDER.length - 1 && (
                <div
                  className={cn(
                    "mt-1 w-px flex-1 min-h-[16px]",
                    done ? "bg-green-200" : "bg-surface-border",
                  )}
                />
              )}
            </div>
            <div className="pb-3 pt-0.5">
              <p
                className={cn(
                  "text-sm font-medium",
                  done ? "text-navy" : active ? "text-brand-600" : "text-navy/70",
                )}
              >
                {STATUS_LABELS[s]}
              </p>
              {log && <p className="text-xs text-navy/70">{fmtDateTime(log.createdAt)}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReturnDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: ret, isLoading, isError } = useReturn(params.id);
  const approveReturn = useApproveReturn();
  const rejectReturn = useRejectReturn();
  const markInTransit = useMarkReturnInTransit();
  const markReceived = useMarkReturnReceived();
  const processRefund = useProcessRefund();
  const createCreditNote = useCreateCreditNote();

  const [isRefundOpen, setIsRefundOpen] = React.useState(false);
  const [isApproveOpen, setIsApproveOpen] = React.useState(false);
  const [isRejectOpen, setIsRejectOpen] = React.useState(false);

  React.useEffect(() => {
    if (ret) setTitle(ret.returnNumber);
  }, [ret, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !ret) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Return not found.</p>
        <Button variant="secondary" href="/returns">
          Back to Returns
        </Button>
      </div>
    );
  }

  const status = ret.status;

  // ── Action handlers ──────────────────────────────────────────────────────────

  const handleApprove = () => {
    setIsApproveOpen(false);
    approveReturn.mutate(ret.id, {
      onSuccess: () => {
        toast({ title: "Return approved", variant: "success" });
      },
      onError: () => {
        toast({
          title: "Failed to approve return",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleReject = () => {
    rejectReturn.mutate(ret.id, {
      onSuccess: () => {
        setIsRejectOpen(false);
        toast({ title: "Return rejected", variant: "info" });
      },
      onError: () => {
        toast({
          title: "Failed to reject return",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleMarkInTransit = () => {
    markInTransit.mutate(ret.id, {
      onSuccess: () => {
        toast({ title: "Return marked in transit", variant: "success" });
      },
      onError: () => {
        toast({
          title: "Failed to update status",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleMarkReceived = () => {
    markReceived.mutate(ret.id, {
      onSuccess: () => {
        toast({
          title: "Return received",
          description: "Items have been checked in.",
          variant: "success",
        });
      },
      onError: () => {
        toast({
          title: "Failed to update status",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleConvertToCreditNote = () => {
    if (!ret) return;
    const returnTotal = ret.items.reduce((sum, item) => {
      return sum + item.qty * (item.unitPrice ?? 0);
    }, 0);
    createCreditNote.mutate(
      {
        customerId: ret.customerId,
        amount: returnTotal > 0 ? returnTotal : 0.01,
        reason: `Return ${ret.returnNumber} — ${REASON_LABELS[ret.reason]}`,
        issueDate: new Date().toISOString().split("T")[0],
        notes: `Created from return ${ret.returnNumber}. Update the amount before issuing.`,
      },
      {
        onSuccess: () => {
          toast({
            title: "Credit note created",
            description: "Review and update the amount before issuing.",
            variant: "success",
          });
          router.push("/credit-notes");
        },
        onError: () => toast({ title: "Failed to create credit note", variant: "error" }),
      },
    );
  };

  const handleProcessRefund = (restock: boolean) => {
    processRefund.mutate(
      { id: ret.id, restock },
      {
        onSuccess: () => {
          setIsRefundOpen(false);
          toast({
            title: "Refund processed",
            description: restock ? "Items have been restocked." : undefined,
            variant: "success",
          });
        },
        onError: () => {
          toast({
            title: "Failed to process refund",
            description: "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/returns"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Returns
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-navy">{ret.returnNumber}</h1>
          <ReturnStatusBadge status={status} />
        </div>

        {/* Actions based on status */}
        <div className="flex flex-wrap items-center gap-2">
          {status === "PENDING" && (
            <>
              <Button
                size="sm"
                leftIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => setIsApproveOpen(true)}
                loading={approveReturn.isPending}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<XCircle className="h-4 w-4" />}
                onClick={() => setIsRejectOpen(true)}
              >
                Reject
              </Button>
            </>
          )}

          {status === "APPROVED" && (
            <Button
              size="sm"
              leftIcon={<Truck className="h-4 w-4" />}
              onClick={handleMarkInTransit}
              loading={markInTransit.isPending}
            >
              Mark In Transit
            </Button>
          )}

          {status === "IN_TRANSIT" && (
            <Button
              size="sm"
              leftIcon={<PackageCheck className="h-4 w-4" />}
              onClick={handleMarkReceived}
              loading={markReceived.isPending}
            >
              Mark Received
            </Button>
          )}

          {status === "RECEIVED" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<FileText className="h-4 w-4" />}
                onClick={handleConvertToCreditNote}
                loading={createCreditNote.isPending}
              >
                Issue Credit Note
              </Button>
              <Button
                size="sm"
                leftIcon={<RefreshCw className="h-4 w-4" />}
                onClick={() => setIsRefundOpen(true)}
              >
                Process Refund
              </Button>
            </>
          )}

          {(status === "REFUNDED" || status === "PROCESSED") && (
            <span className="text-sm italic text-navy/70">Return fully processed.</span>
          )}

          {status === "REJECTED" && (
            <span className="text-sm italic text-navy/70">This return was rejected.</span>
          )}

          {status === "CANCELLED" && (
            <span className="text-sm italic text-navy/70">This return was cancelled.</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Main content (2/3) ── */}
        <div className="space-y-5 lg:col-span-2">
          {/* Detail card */}
          <Card>
            <div className="mb-6 grid grid-cols-2 gap-6">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Customer
                </p>
                <p className="text-sm font-semibold text-navy">
                  {ret.customer?.businessName ?? "—"}
                </p>
                {ret.customer?.contactName && (
                  <p className="text-sm text-navy/70">{ret.customer.contactName}</p>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Return Details
                </p>
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Return #:</span> {ret.returnNumber}
                </p>
                {ret.order && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Order #:</span>{" "}
                    <Link
                      href={`/orders/${ret.orderId}`}
                      className="text-brand-500 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {ret.order.orderNumber}
                    </Link>
                  </p>
                )}
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Reason:</span> {REASON_LABELS[ret.reason]}
                </p>
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Submitted:</span> {fmtDate(ret.createdAt)}
                </p>
              </div>
            </div>

            {/* Notes */}
            {ret.notes && (
              <div className="mb-6 rounded-lg bg-surface-raised p-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Notes
                </p>
                <p className="text-sm text-navy/70 whitespace-pre-line">{ret.notes}</p>
              </div>
            )}

            {/* Items table */}
            <div className="-mx-6 overflow-hidden border-t border-surface-border">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised">
                  <tr>
                    <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/70">
                      Product
                    </th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-navy/70">
                      Ordered Qty
                    </th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-navy/70">
                      Return Qty
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-navy/70">
                      Condition / Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {ret.items.map((item) => (
                    <tr key={item.id} className="hover:bg-surface-raised">
                      <td className="px-6 py-3 font-medium text-navy">
                        {item.product?.name ?? item.productId}
                      </td>
                      <td className="px-4 py-3 text-center text-navy/70">{item.orderedQty}</td>
                      <td className="px-4 py-3 text-center font-semibold text-navy">{item.qty}</td>
                      <td className="px-4 py-3 text-navy/70">
                        {item.condition && (
                          <span className="mr-2 inline-flex items-center rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-navy">
                            {item.condition}
                          </span>
                        )}
                        {item.notes && <span className="text-xs text-navy/70">{item.notes}</span>}
                        {!item.condition && !item.notes && <span className="text-navy/30">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* ── Sidebar (1/3) ── */}
        <div className="space-y-4">
          {/* Status timeline */}
          <Card title="Status Timeline">
            <StatusTimeline currentStatus={status} logs={ret.logs} />
          </Card>

          {/* Quick summary */}
          <Card>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/70">Items</dt>
                <dd className="font-medium text-navy">{ret.items.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Total Return Qty</dt>
                <dd className="font-medium text-navy">
                  {ret.items.reduce((sum, i) => sum + Number(i.qty), 0)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-2">
                <dt className="text-navy/70">Reason</dt>
                <dd className="font-medium text-navy">{REASON_LABELS[ret.reason]}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      {/* Modals */}
      <ProcessRefundModal
        isOpen={isRefundOpen}
        onClose={() => setIsRefundOpen(false)}
        onConfirm={handleProcessRefund}
        isPending={processRefund.isPending}
      />

      <ConfirmActionModal
        isOpen={isApproveOpen}
        onClose={() => setIsApproveOpen(false)}
        onConfirm={handleApprove}
        title="Approve Return?"
        description={`Approve return ${ret.returnNumber}? The customer will be notified and the return will move to Approved status.`}
        confirmLabel="Approve Return"
        variant="primary"
        isPending={approveReturn.isPending}
      />

      <ConfirmActionModal
        isOpen={isRejectOpen}
        onClose={() => setIsRejectOpen(false)}
        onConfirm={handleReject}
        title="Reject Return?"
        description={`Return ${ret.returnNumber} will be marked as rejected. This action cannot be undone.`}
        confirmLabel="Reject Return"
        variant="danger"
        isPending={rejectReturn.isPending}
      />
    </div>
  );
}
