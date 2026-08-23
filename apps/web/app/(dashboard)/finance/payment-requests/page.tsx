"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import {
  usePaymentRequests,
  useApprovePaymentRequest,
  useRejectPaymentRequest,
  type PaymentRequest,
} from "@/lib/api/payment-requests";
import { useToast, EmptyState, Button, Badge, Modal, Textarea } from "@routeflow/ui/web";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "just now" / "12m ago" / "3h ago" / "2d ago" for the request queue. */
function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function extractErrorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
}

const DECISION_LABELS: Partial<Record<PaymentRequest["status"], string>> = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "FAILED", label: "Failed" },
  { value: "EXPIRED", label: "Expired" },
  { value: "", label: "All" },
];

// ─── Allocation preview ───────────────────────────────────────────────────────

function AllocationPreview({ lines }: { lines: PaymentRequest["allocationPreview"] }) {
  if (!lines || lines.length === 0) {
    return (
      <p className="text-sm italic text-navy/70">
        No open invoices for this customer — the full amount goes on account as credit.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-surface-raised text-xs font-medium text-navy/70">
          <tr>
            <th className="px-3 py-2 text-left">Invoice #</th>
            <th className="px-3 py-2 text-left">Issue date</th>
            <th className="px-3 py-2 text-right">Balance due</th>
            <th className="px-3 py-2 text-right">Applies</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {lines.map((l) => (
            <tr key={l.invoiceId}>
              <td className="px-3 py-2 font-medium text-brand-600">{l.invoiceNumber}</td>
              <td className="px-3 py-2 text-navy/70">{fmtCalendarDate(l.issueDate)}</td>
              <td className="px-3 py-2 text-right text-navy">{fmt(l.balanceDue)}</td>
              <td className="px-3 py-2 text-right font-medium text-navy">
                {fmt(l.applied)}
                {l.applied < l.balanceDue - 0.001 && (
                  <span className="ml-1 text-xs font-normal text-warning">(partial)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Request row ────────────────────────────────────────────────────────────

function RequestRow({
  request: r,
  onApprove,
  onReject,
}: {
  request: PaymentRequest;
  onApprove: (r: PaymentRequest) => void;
  onReject: (r: PaymentRequest) => void;
}) {
  const isPendingCash = r.kind === "CASH" && r.status === "PENDING";

  return (
    <div>
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-navy">{r.customerName}</span>
            <Badge
              variant={r.kind === "CARD" ? "info" : "neutral"}
              label={r.kind === "CARD" ? "Card" : "Cash"}
            />
            <Badge status={r.status} />
          </div>
          {r.contactName && <p className="mt-0.5 text-xs text-navy/70">{r.contactName}</p>}
          {(r.note || r.reference) && (
            <p className="mt-1 text-xs text-navy/70">
              {r.note}
              {r.note && r.reference ? " · " : ""}
              {r.reference ? `Ref: ${r.reference}` : ""}
            </p>
          )}
          <p className="mt-1 text-xs text-navy/50">{formatAge(r.createdAt)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="text-lg font-semibold text-navy">{fmt(r.amount)}</span>
          {isPendingCash ? (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => onReject(r)}>
                Reject
              </Button>
              <Button size="sm" onClick={() => onApprove(r)}>
                Approve
              </Button>
            </div>
          ) : r.decidedByName ? (
            <p className="text-right text-xs text-navy/70">
              {DECISION_LABELS[r.status] ?? r.status} by {r.decidedByName}
              {r.decidedAt && <> · {fmtDate(r.decidedAt)}</>}
            </p>
          ) : (
            <p className="text-right text-xs text-navy/70">
              {r.kind === "CARD" ? "Settles automatically via Stripe" : "—"}
            </p>
          )}
        </div>
      </div>

      {isPendingCash && (
        <div className="border-t border-surface-border bg-surface-raised/40 px-4 py-3">
          <p className="mb-2 text-xs text-navy/70">Payments settle the oldest invoices first.</p>
          <AllocationPreview lines={r.allocationPreview} />
        </div>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function PaymentRequestsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Payment Requests");
  }, [setTitle]);
  const { toast } = useToast();

  const [status, setStatus] = React.useState("PENDING");
  const { data, isLoading, isError, refetch, isRefetching } = usePaymentRequests(
    status || undefined,
  );
  const requests = data ?? [];

  const approve = useApprovePaymentRequest();
  const reject = useRejectPaymentRequest();

  const [approveTarget, setApproveTarget] = React.useState<PaymentRequest | null>(null);
  const [rejectTarget, setRejectTarget] = React.useState<PaymentRequest | null>(null);
  const [rejectReason, setRejectReason] = React.useState("");

  const handleApprove = async () => {
    if (!approveTarget) return;
    try {
      const res = await approve.mutateAsync(approveTarget.id);
      toast({
        title: "Payment approved",
        description:
          res.excess > 0.001 ? `${fmt(res.excess)} left on account as credit.` : undefined,
        variant: "success",
      });
      setApproveTarget(null);
    } catch (err: unknown) {
      toast({ title: extractErrorMessage(err) ?? "Failed to approve payment", variant: "error" });
    }
  };

  const closeReject = () => {
    setRejectTarget(null);
    setRejectReason("");
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    try {
      await reject.mutateAsync({ id: rejectTarget.id, reason: rejectReason || undefined });
      toast({ title: "Payment rejected", variant: "success" });
      closeReject();
    } catch (err: unknown) {
      toast({ title: extractErrorMessage(err) ?? "Failed to reject payment", variant: "error" });
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Approve confirm */}
      <Modal
        open={!!approveTarget}
        onClose={() => setApproveTarget(null)}
        title="Approve cash payment?"
        description={
          approveTarget
            ? `Records ${fmt(approveTarget.amount)} from ${approveTarget.customerName} and applies it to the invoices below.`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setApproveTarget(null)}
              disabled={approve.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleApprove} loading={approve.isPending}>
              Approve
            </Button>
          </>
        }
      >
        {approveTarget && <AllocationPreview lines={approveTarget.allocationPreview} />}
      </Modal>

      {/* Reject prompt */}
      <Modal
        open={!!rejectTarget}
        onClose={closeReject}
        title="Reject cash payment?"
        description={
          rejectTarget
            ? `The buyer's declared ${fmt(rejectTarget.amount)} payment will be marked rejected — no money is recorded.`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeReject} disabled={reject.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleReject} loading={reject.isPending}>
              Reject
            </Button>
          </>
        }
      >
        <Textarea
          label="Reason (optional, shown to the buyer)"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="e.g. Amount doesn't match what we received"
          rows={3}
        />
      </Modal>

      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-navy">Payment Requests</h2>
        <p className="text-sm text-navy/70">
          Buyer-declared cash payments awaiting approval, plus card payment history.
        </p>
      </div>

      {/* Filter bar */}
      <div className="rounded-xl border border-surface-border bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-navy/70" htmlFor="payment-requests-status">
            Status
          </label>
          <select
            id="payment-requests-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
          </div>
        ) : isError ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-danger">
              Couldn&apos;t load payment requests — you may not have permission, or the connection
              failed.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refetch()}
              loading={isRefetching}
            >
              Try again
            </Button>
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            variant="invoices"
            title="No payment requests"
            description={
              status === "PENDING"
                ? "No cash declarations are waiting on review right now."
                : "No requests match this status."
            }
          />
        ) : (
          <div className="divide-y divide-surface-border">
            {requests.map((r) => (
              <RequestRow
                key={r.id}
                request={r}
                onApprove={setApproveTarget}
                onReject={setRejectTarget}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
