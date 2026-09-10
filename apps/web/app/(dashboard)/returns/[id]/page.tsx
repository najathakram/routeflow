"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Truck,
  PackageCheck,
  RefreshCw,
  SkipForward,
  Loader2,
  Clock,
  Ban,
} from "lucide-react";
import { Button, Card, Modal, cn, useToast, Badge } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useReturn,
  useApproveReturn,
  useRejectReturn,
  useMarkReturnInTransit,
  useMarkReturnReceived,
  useProcessRefund,
  useCancelReturn,
  type Return,
  type ReturnStatus,
  type ReturnReason,
  type RefundMethod,
} from "@/lib/api/returns";

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

// ─── Status timeline labels ────────────────────────────────────────────────────

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

// ─── Reason label ─────────────────────────────────────────────────────────────

const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong Item",
  EXCESS_ORDER: "Excess / Overdelivery",
  CUSTOMER_REFUSED: "Customer Refused",
  QUALITY_ISSUE: "Quality Issue",
};

const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
  CREDIT_NOTE: "Store credit (credit note)",
  EXTERNAL_REFUND: "Refunded outside RouteFlow",
};

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : `$${Number(n).toFixed(2)}`;
}

// `refundEstimateReason` is a machine token on the wire (the api keeps it that way so the
// field stays parseable); the copy layer lives here. Unknown tokens fall back to a generic
// line rather than leaking SCREAMING_SNAKE at the operator.
const REFUND_ESTIMATE_REASON_LABELS: Record<string, string> = {
  NOTHING_CREDITABLE: "Nothing billed on this order can be refunded.",
};

function refundEstimateReasonText(reason: string): string {
  return REFUND_ESTIMATE_REASON_LABELS[reason] ?? "No refundable amount";
}

// ─── Resolve Return Modal ─────────────────────────────────────────────────────

function ResolveReturnModal({
  isOpen,
  onClose,
  onConfirm,
  isPending,
  refundEstimate,
  refundEstimateReason,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (method: RefundMethod) => void;
  isPending: boolean;
  refundEstimate?: number | null;
  refundEstimateReason?: string | null;
}) {
  const [method, setMethod] = React.useState<RefundMethod>("CREDIT_NOTE");

  React.useEffect(() => {
    if (isOpen) setMethod("CREDIT_NOTE");
  }, [isOpen]);

  const amountLabel = fmtMoney(refundEstimate);
  // The server reports 0 WITH a reason when the basis is not creditable (nothing
  // billed / no headroom left). Showing it here is the difference between a genuine
  // $0 and a store-credit attempt that can only ever be refused.
  const estimateReasonLabel =
    refundEstimateReason && !refundEstimate ? refundEstimateReasonText(refundEstimateReason) : null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Resolve Return"
      description={`Choose how the ${amountLabel} for this return is settled with the customer.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(method)} loading={isPending}>
            Resolve Return
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {estimateReasonLabel && <p className="text-xs text-navy/70">{estimateReasonLabel}</p>}
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-border p-3 hover:bg-surface-raised">
          <input
            type="radio"
            name="resolve-method"
            checked={method === "CREDIT_NOTE"}
            onChange={() => setMethod("CREDIT_NOTE")}
            className="mt-0.5 accent-brand-500"
          />
          <span>
            <span className="block text-sm font-medium text-navy">
              Issue store credit (credit note)
            </span>
            <span className="block text-xs text-navy/70">
              Mints a {amountLabel} credit note for the customer, linked to this return.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-border p-3 hover:bg-surface-raised">
          <input
            type="radio"
            name="resolve-method"
            checked={method === "EXTERNAL_REFUND"}
            onChange={() => setMethod("EXTERNAL_REFUND")}
            className="mt-0.5 accent-brand-500"
          />
          <span>
            <span className="block text-sm font-medium text-navy">
              Refunded outside RouteFlow (cash, check, transfer)
            </span>
            <span className="block text-xs text-navy/70">
              Records that {amountLabel} was already returned to the customer. Nothing is minted.
            </span>
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

export default function ReturnDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: ret, isLoading, isError } = useReturn(id);
  const approveReturn = useApproveReturn();
  const rejectReturn = useRejectReturn();
  const markInTransit = useMarkReturnInTransit();
  const markReceived = useMarkReturnReceived();
  const processRefund = useProcessRefund();
  const cancelReturn = useCancelReturn();

  const [isRefundOpen, setIsRefundOpen] = React.useState(false);
  const [isApproveOpen, setIsApproveOpen] = React.useState(false);
  const [isRejectOpen, setIsRejectOpen] = React.useState(false);
  const [isCancelOpen, setIsCancelOpen] = React.useState(false);

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
  const canCancel = (["PENDING", "APPROVED", "IN_TRANSIT", "RECEIVED"] as ReturnStatus[]).includes(
    status,
  );

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
    markReceived.mutate(
      { id: ret.id },
      {
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
      },
    );
  };

  // "Resolve without receiving": receive with restock suppressed, then fall straight
  // into the same resolve modal. If the operator abandons that second step the return
  // simply sits at RECEIVED, which is truthful — nothing was minted or restocked.
  const handleResolveWithoutReceiving = () => {
    markReceived.mutate(
      { id: ret.id, restock: false },
      {
        onSuccess: () => {
          setIsRefundOpen(true);
        },
        onError: () => {
          toast({
            title: "Failed to update status",
            description: "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleCancel = () => {
    cancelReturn.mutate(ret.id, {
      onSuccess: () => {
        setIsCancelOpen(false);
        toast({ title: "Return cancelled", variant: "info" });
      },
      onError: () => {
        toast({
          title: "Failed to cancel return",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleResolveReturn = (method: RefundMethod) => {
    processRefund.mutate(
      { id: ret.id, method },
      {
        onSuccess: () => {
          setIsRefundOpen(false);
          toast({
            title: method === "CREDIT_NOTE" ? "Store credit issued" : "Refund recorded",
            description:
              method === "CREDIT_NOTE"
                ? "A credit note has been minted for the customer."
                : "The return has been marked as refunded outside RouteFlow.",
            variant: "success",
          });
        },
        // The refund path can refuse permanently (nothing billed is refundable, no
        // headroom left on the order's invoices, or a named invoice is out of room).
        // Retrying never clears those, so the server's message — which names the
        // invoice and points at the EXTERNAL_REFUND exit — must reach the operator;
        // "Please try again." is only the fallback for an error with no message.
        onError: (err: unknown) => {
          const message = (err as { response?: { data?: { message?: string } } })?.response?.data
            ?.message;
          toast({
            title: "Failed to resolve return",
            description: message ?? "Please try again.",
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
          <Badge status={status} />
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
            <>
              <Button
                size="sm"
                leftIcon={<Truck className="h-4 w-4" />}
                onClick={handleMarkInTransit}
                loading={markInTransit.isPending}
              >
                Mark In Transit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<SkipForward className="h-4 w-4" />}
                onClick={handleResolveWithoutReceiving}
                loading={markReceived.isPending}
              >
                Resolve without receiving
              </Button>
            </>
          )}

          {status === "IN_TRANSIT" && (
            <>
              <Button
                size="sm"
                leftIcon={<PackageCheck className="h-4 w-4" />}
                onClick={handleMarkReceived}
                loading={markReceived.isPending}
              >
                Mark Received
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<SkipForward className="h-4 w-4" />}
                onClick={handleResolveWithoutReceiving}
                loading={markReceived.isPending}
              >
                Resolve without receiving
              </Button>
            </>
          )}

          {status === "RECEIVED" && (
            <Button
              size="sm"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={() => setIsRefundOpen(true)}
            >
              Resolve Return
            </Button>
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

          {canCancel && (
            <Button
              size="sm"
              variant="danger"
              leftIcon={<Ban className="h-4 w-4" />}
              onClick={() => setIsCancelOpen(true)}
            >
              Cancel Return
            </Button>
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

          {/* Resolution — how this return was settled with the customer.
              creditNoteId is part of the gate on purpose: returns refunded before the
              refundMethod/refundAmount/refundedAt columns shipped carry only creditNoteId
              (no backfill), and the credit-note link must still reach them. */}
          {(ret.refundMethod || ret.refundedAt || ret.creditNoteId) && (
            <Card title="Resolution">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-navy/70">Method</dt>
                  <dd className="font-medium text-navy">
                    {ret.refundMethod ? REFUND_METHOD_LABELS[ret.refundMethod] : "—"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-navy/70">Amount</dt>
                  <dd className="font-medium text-navy">{fmtMoney(ret.refundAmount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-navy/70">Date</dt>
                  <dd className="font-medium text-navy">
                    {ret.refundedAt ? fmtDate(ret.refundedAt) : "—"}
                  </dd>
                </div>
                {ret.creditNoteId && (
                  <div className="flex justify-between border-t border-surface-border pt-2">
                    <dt className="text-navy/70">Credit note</dt>
                    <dd>
                      <Link
                        href={`/credit-notes/${ret.creditNoteId}`}
                        className="font-mono text-brand-600 hover:underline"
                      >
                        {ret.creditNote?.creditNoteNumber ?? ret.creditNoteId}
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
            </Card>
          )}

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
      <ResolveReturnModal
        isOpen={isRefundOpen}
        onClose={() => setIsRefundOpen(false)}
        onConfirm={handleResolveReturn}
        isPending={processRefund.isPending}
        refundEstimate={ret.refundEstimate}
        refundEstimateReason={ret.refundEstimateReason}
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

      <ConfirmActionModal
        isOpen={isCancelOpen}
        onClose={() => setIsCancelOpen(false)}
        onConfirm={handleCancel}
        title="Cancel Return?"
        description={`Return ${ret.returnNumber} will be marked as cancelled. This action cannot be undone.`}
        confirmLabel="Cancel Return"
        variant="danger"
        isPending={cancelReturn.isPending}
      />
    </div>
  );
}
