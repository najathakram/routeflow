"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Loader2,
  Send,
  ThumbsDown,
  ThumbsUp,
  FileText,
} from "lucide-react";
import { Button, Badge, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useEstimate,
  useSendEstimate,
  useAcceptEstimate,
  useDeclineEstimate,
  useConvertEstimateToInvoice,
  useVoidEstimate,
} from "@/lib/api/estimates";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { DocumentLetterhead } from "@/components/DocumentLetterhead";

// ─── Void confirm modal ───────────────────────────────────────────────────────

function VoidConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  estimateNumber,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  estimateNumber: string;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Void Estimate?"
      description={`Estimate ${estimateNumber} will be marked as void. This action cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isPending}>
            Void Estimate
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        Voiding this estimate will mark it as cancelled. The customer will no longer be able to
        accept it.
      </p>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EstimateDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: estimate, isLoading, isError } = useEstimate(params.id);
  const sendEstimate = useSendEstimate();
  const acceptEstimate = useAcceptEstimate();
  const declineEstimate = useDeclineEstimate();
  const convertToInvoice = useConvertEstimateToInvoice();
  const voidEstimate = useVoidEstimate();

  const [isVoidOpen, setIsVoidOpen] = React.useState(false);

  React.useEffect(() => {
    if (estimate) setTitle(estimate.estimateNumber);
  }, [estimate, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !estimate) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Estimate not found.</p>
        <Button variant="secondary" href="/estimates">
          Back to Estimates
        </Button>
      </div>
    );
  }

  const status = estimate.status;
  const subtotal = Number(estimate.subtotal);
  const tax = Number(estimate.taxAmount ?? 0);
  const total = Number(estimate.total);

  // ── Action handlers ──────────────────────────────────────────────────────────

  const handleSend = () => {
    sendEstimate.mutate(estimate.id, {
      onSuccess: () => {
        toast({
          title: "Estimate sent",
          description: `${estimate.estimateNumber} has been sent to the customer.`,
          variant: "success",
        });
      },
      onError: () => {
        toast({
          title: "Failed to send estimate",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleAccept = () => {
    acceptEstimate.mutate(estimate.id, {
      onSuccess: () => {
        toast({
          title: "Estimate accepted",
          description: `${estimate.estimateNumber} has been marked as accepted.`,
          variant: "success",
        });
      },
      onError: () => {
        toast({
          title: "Failed to accept estimate",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleDecline = () => {
    declineEstimate.mutate(estimate.id, {
      onSuccess: () => {
        toast({
          title: "Estimate declined",
          description: `${estimate.estimateNumber} has been marked as declined.`,
          variant: "info",
        });
      },
      onError: () => {
        toast({
          title: "Failed to decline estimate",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleConvert = () => {
    convertToInvoice.mutate(estimate.id, {
      onSuccess: ({ invoiceId }) => {
        toast({
          title: "Invoice created",
          description: `${estimate.estimateNumber} has been converted to an invoice.`,
          variant: "success",
        });
        router.push(`/invoices/${invoiceId}`);
      },
      onError: () => {
        toast({
          title: "Failed to convert estimate",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleVoid = () => {
    voidEstimate.mutate(estimate.id, {
      onSuccess: () => {
        setIsVoidOpen(false);
        toast({
          title: "Estimate voided",
          description: `${estimate.estimateNumber} has been voided.`,
          variant: "info",
        });
      },
      onError: () => {
        toast({
          title: "Failed to void estimate",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const canConvert = status === "DRAFT" || status === "SENT" || status === "ACCEPTED";
  const isReadOnly = status === "DECLINED" || status === "EXPIRED";

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/estimates"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Estimates
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-navy">{estimate.estimateNumber}</h2>
          <Badge status={status} />
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {status === "DRAFT" && (
            <>
              <Button
                size="sm"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={handleSend}
                loading={sendEstimate.isPending}
              >
                Send
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<FileText className="h-4 w-4" />}
                onClick={handleConvert}
                loading={convertToInvoice.isPending}
              >
                Convert to Invoice
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<Ban className="h-4 w-4" />}
                onClick={() => setIsVoidOpen(true)}
              >
                Void
              </Button>
            </>
          )}

          {status === "SENT" && (
            <>
              <Button
                size="sm"
                leftIcon={<ThumbsUp className="h-4 w-4" />}
                onClick={handleAccept}
                loading={acceptEstimate.isPending}
              >
                Mark Accepted
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<ThumbsDown className="h-4 w-4" />}
                onClick={handleDecline}
                loading={declineEstimate.isPending}
              >
                Mark Declined
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<FileText className="h-4 w-4" />}
                onClick={handleConvert}
                loading={convertToInvoice.isPending}
              >
                Convert to Invoice
              </Button>
            </>
          )}

          {status === "ACCEPTED" && (
            <Button
              size="sm"
              leftIcon={<FileText className="h-4 w-4" />}
              onClick={handleConvert}
              loading={convertToInvoice.isPending}
            >
              Convert to Invoice
            </Button>
          )}

          {isReadOnly && (
            <span className="text-sm italic text-navy/70">
              {status === "DECLINED" ? "This estimate was declined." : "This estimate has expired."}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Estimate preview (2/3) ── */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            {/* Letterhead */}
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <DocumentLetterhead />
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-navy">ESTIMATE</p>
                <p className="mt-1 font-mono text-sm text-navy/70">{estimate.estimateNumber}</p>
              </div>
            </div>

            {/* Customer + Dates */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Prepared For
                </p>
                <p className="text-sm font-semibold text-navy">
                  {estimate.customer?.businessName ?? "—"}
                </p>
                {estimate.customer?.contactName && (
                  <p className="text-sm text-navy/70">{estimate.customer.contactName}</p>
                )}
                {estimate.customer?.address && (
                  <p className="mt-1 text-xs text-navy/70 whitespace-pre-line">
                    {estimate.customer.address}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Estimate Details
                </p>
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Issue Date:</span>{" "}
                  {fmtCalendarDate((estimate as any).issueDate ?? estimate.createdAt)}
                </p>
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Valid Until:</span>{" "}
                  {fmtCalendarDate((estimate as any).expiresAt ?? (estimate as any).expiryDate)}
                </p>
              </div>
            </div>

            {/* Line items */}
            <div className="-mx-6 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised">
                  <tr>
                    <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/70">
                      Description
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">Qty</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">
                      Unit Price
                    </th>
                    <th className="px-6 py-2.5 text-right text-xs font-medium text-navy/70">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {estimate.items.map((item) => (
                    <tr key={item.id} className="hover:bg-surface-raised">
                      <td className="px-6 py-3 text-navy">{item.description}</td>
                      <td className="px-4 py-3 text-right text-navy/70">{item.qty}</td>
                      <td className="px-4 py-3 text-right text-navy/70">
                        {fmt(Number(item.unitPrice))}
                      </td>
                      <td className="px-6 py-3 text-right font-medium text-navy">
                        {/* Stored line subtotal is authoritative (boxed-aware, rounded via
                            pricing.ts). NEVER re-derive qty*unitPrice — it over-charges boxed
                            lines by unitsPerBox. */}
                        {fmt(Number(item.subtotal ?? Number(item.qty) * Number(item.unitPrice)))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals footer */}
            <div className="mt-4 border-t border-surface-border pt-4">
              <div className="ml-auto w-56 space-y-2 text-sm">
                <div className="flex justify-between text-navy/70">
                  <span>Subtotal</span>
                  <span>{fmt(subtotal)}</span>
                </div>
                <div className="flex justify-between text-navy/70">
                  <span>Tax</span>
                  <span>{fmt(tax)}</span>
                </div>
                <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-navy">
                  <span>Total</span>
                  <span>{fmt(total)}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            {estimate.notes && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Notes
                </p>
                <p className="text-sm text-navy/70 whitespace-pre-line">{estimate.notes}</p>
              </div>
            )}
          </Card>
        </div>

        {/* ── Sidebar (1/3) ── */}
        <div className="space-y-4">
          <Card title="Summary">
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/70">Status</dt>
                <dd>
                  <Badge status={status} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Subtotal</dt>
                <dd className="text-navy">{fmt(subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Tax</dt>
                <dd className="text-navy">{fmt(tax)}</dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-2 font-bold text-navy">
                <dt>Total</dt>
                <dd>{fmt(total)}</dd>
              </div>
            </dl>

            {canConvert && (
              <div className="mt-4 space-y-2">
                <Button
                  size="sm"
                  className="w-full"
                  leftIcon={<FileText className="h-4 w-4" />}
                  onClick={handleConvert}
                  loading={convertToInvoice.isPending}
                >
                  Convert to Invoice
                </Button>
              </div>
            )}

            {status === "SENT" && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<ThumbsUp className="h-4 w-4" />}
                  onClick={handleAccept}
                  loading={acceptEstimate.isPending}
                >
                  Accept
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<ThumbsDown className="h-4 w-4" />}
                  onClick={handleDecline}
                  loading={declineEstimate.isPending}
                >
                  Decline
                </Button>
              </div>
            )}
          </Card>

          <Card title="Dates">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/70">Issue Date</dt>
                <dd className="text-navy">
                  {fmtCalendarDate((estimate as any).issueDate ?? estimate.createdAt)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Valid Until</dt>
                <dd className="text-navy">
                  {fmtCalendarDate((estimate as any).expiresAt ?? (estimate as any).expiryDate)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card title="Audit">
            <dl className="space-y-2 text-xs text-navy/70">
              <div className="flex justify-between">
                <dt>Created</dt>
                <dd>{fmtDate(estimate.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Last Updated</dt>
                <dd>{fmtDate(estimate.updatedAt)}</dd>
              </div>
            </dl>
          </Card>

          {!isReadOnly && (
            <div className="pt-1">
              <button
                onClick={() => setIsVoidOpen(true)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
              >
                <Ban className="h-4 w-4" />
                Void Estimate
              </button>
            </div>
          )}

          {status === "ACCEPTED" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <p className="text-sm font-medium text-green-800">Customer Accepted</p>
              </div>
              <p className="mt-1 text-xs text-green-700">
                This estimate has been accepted. Convert it to an invoice to proceed.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <VoidConfirmModal
        isOpen={isVoidOpen}
        onClose={() => setIsVoidOpen(false)}
        onConfirm={handleVoid}
        estimateNumber={estimate.estimateNumber}
        isPending={voidEstimate.isPending}
      />
    </div>
  );
}
