"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  FileText,
  Loader2,
  Send,
  Receipt,
  Search,
} from "lucide-react";
import { Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useCreditNote,
  useIssueCreditNote,
  useApplyCreditNote,
  useVoidCreditNote,
  type CreditNoteStatus,
} from "@/lib/api/credit-notes";
import { useInvoices } from "@/lib/api/invoices";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<CreditNoteStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  ISSUED: "bg-blue-100 text-blue-700",
  APPLIED: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
};

function CreditNoteStatusBadge({ status }: { status: CreditNoteStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status],
      )}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ─── Void confirm modal ───────────────────────────────────────────────────────

function VoidConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  cnNumber,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  cnNumber: string;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Void Credit Note?"
      description={`Credit note ${cnNumber} will be marked as void. This action cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isPending}>
            Void Credit Note
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        Voiding this credit note will mark it as cancelled. It can no longer be issued or applied.
      </p>
    </Modal>
  );
}

// ─── Apply to Invoice modal ───────────────────────────────────────────────────

function ApplyToInvoiceModal({
  isOpen,
  onClose,
  onApply,
  customerId,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onApply: (invoiceId: string) => void;
  customerId: string;
  isPending: boolean;
}) {
  const [selectedInvoiceId, setSelectedInvoiceId] = React.useState("");
  const [error, setError] = React.useState("");

  const { data: invoicesData } = useInvoices({ limit: 100 });
  const invoices = React.useMemo(() => {
    const all = invoicesData?.data ?? [];
    return all.filter(
      (inv) =>
        inv.customerId === customerId &&
        (inv.status === "SENT" || inv.status === "VIEWED" || inv.status === "PARTIAL" || inv.status === "OVERDUE"),
    );
  }, [invoicesData, customerId]);

  React.useEffect(() => {
    if (isOpen) {
      setSelectedInvoiceId("");
      setError("");
    }
  }, [isOpen]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedInvoiceId) { setError("Select an invoice to apply this credit note to."); return; }
    setError("");
    onApply(selectedInvoiceId);
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Apply to Invoice"
      description="Select an open invoice to apply this credit note against."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="apply-cn-form" loading={isPending}>
            Apply Credit Note
          </Button>
        </>
      }
    >
      <form id="apply-cn-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Invoice</label>
          {invoices.length === 0 ? (
            <p className="text-sm text-navy/50">No open invoices found for this customer.</p>
          ) : (
            <select
              value={selectedInvoiceId}
              onChange={(e) => setSelectedInvoiceId(e.target.value)}
              className={cn(
                "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                error ? "border-danger" : "border-surface-border",
              )}
            >
              <option value="">Select invoice…</option>
              {invoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNumber} — {fmt.format(Number(inv.balanceDue))} due
                </option>
              ))}
            </select>
          )}
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CreditNoteDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: cn, isLoading, isError } = useCreditNote(params.id);
  const issueCreditNote = useIssueCreditNote();
  const applyCreditNote = useApplyCreditNote();
  const voidCreditNote = useVoidCreditNote();

  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isApplyOpen, setIsApplyOpen] = React.useState(false);

  React.useEffect(() => {
    if (cn) setTitle(cn.creditNoteNumber);
  }, [cn, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
      </div>
    );
  }

  if (isError || !cn) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Credit note not found.</p>
        <Button variant="secondary" href="/credit-notes">
          Back to Credit Notes
        </Button>
      </div>
    );
  }

  const status = cn.status;

  // ── Action handlers ──────────────────────────────────────────────────────────

  const handleIssue = () => {
    issueCreditNote.mutate(cn.id, {
      onSuccess: () => {
        toast({
          title: "Credit note issued",
          description: `${cn.creditNoteNumber} has been issued.`,
          variant: "success",
        });
      },
      onError: () => {
        toast({ title: "Failed to issue credit note", description: "Please try again.", variant: "error" });
      },
    });
  };

  const handleVoid = () => {
    voidCreditNote.mutate(cn.id, {
      onSuccess: () => {
        setIsVoidOpen(false);
        toast({
          title: "Credit note voided",
          description: `${cn.creditNoteNumber} has been voided.`,
          variant: "info",
        });
      },
      onError: () => {
        toast({ title: "Failed to void credit note", description: "Please try again.", variant: "error" });
      },
    });
  };

  const handleApply = (invoiceId: string) => {
    applyCreditNote.mutate(
      { id: cn.id, invoiceId },
      {
        onSuccess: () => {
          setIsApplyOpen(false);
          toast({
            title: "Credit note applied",
            description: `${cn.creditNoteNumber} has been applied to the invoice.`,
            variant: "success",
          });
        },
        onError: () => {
          toast({ title: "Failed to apply credit note", description: "Please try again.", variant: "error" });
        },
      },
    );
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/credit-notes"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Credit Notes
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-navy">{cn.creditNoteNumber}</h1>
          <CreditNoteStatusBadge status={status} />
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {status === "DRAFT" && (
            <>
              <Button
                size="sm"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={handleIssue}
                loading={issueCreditNote.isPending}
              >
                Issue
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

          {status === "ISSUED" && (
            <>
              <Button
                size="sm"
                leftIcon={<Receipt className="h-4 w-4" />}
                onClick={() => setIsApplyOpen(true)}
              >
                Apply to Invoice
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

          {(status === "APPLIED" || status === "VOID") && (
            <span className="text-sm italic text-navy/40">
              {status === "APPLIED" ? "This credit note has been applied." : "This credit note is void."}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Detail card (2/3) ── */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            {/* Letterhead */}
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
                    RF
                  </div>
                  <span className="text-lg font-bold text-navy">RouteFlow</span>
                </div>
                <p className="mt-1 text-xs text-navy/50">Austin, TX · routeflow.io</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-navy">CREDIT NOTE</p>
                <p className="mt-1 font-mono text-sm text-navy/60">{cn.creditNoteNumber}</p>
              </div>
            </div>

            {/* Customer + Dates */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                  Credit To
                </p>
                <p className="text-sm font-semibold text-navy">
                  {cn.customer?.businessName ?? "—"}
                </p>
                {cn.customer?.contactName && (
                  <p className="text-sm text-navy/60">{cn.customer.contactName}</p>
                )}
                {cn.customer?.address && (
                  <p className="mt-1 text-xs text-navy/50 whitespace-pre-line">
                    {cn.customer.address}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                  Details
                </p>
                <p className="text-sm text-navy/60">
                  <span className="font-medium text-navy">Issue Date:</span>{" "}
                  {fmtDate((cn as any).issueDate ?? cn.createdAt)}
                </p>
                {cn.invoiceId && (
                  <p className="mt-1 text-sm text-navy/60">
                    <span className="font-medium text-navy">Applied to Invoice:</span>{" "}
                    <Link
                      href={`/invoices/${cn.invoiceId}`}
                      className="text-brand-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {cn.invoiceId}
                    </Link>
                  </p>
                )}
              </div>
            </div>

            {/* Amount row */}
            <div className="rounded-lg border border-surface-border bg-surface-raised px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
                    Credit Amount
                  </p>
                  <p className="mt-1 text-3xl font-bold text-navy">{fmt.format(Number(cn.amount))}</p>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                  <FileText className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </div>

            {/* Reason */}
            <div className="mt-6 border-t border-surface-border pt-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                Reason
              </p>
              <p className="text-sm text-navy/80 whitespace-pre-line">{cn.reason}</p>
            </div>

            {/* Notes */}
            {cn.notes && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                  Notes
                </p>
                <p className="text-sm text-navy/70 whitespace-pre-line">{cn.notes}</p>
              </div>
            )}
          </Card>
        </div>

        {/* ── Sidebar (1/3) ── */}
        <div className="space-y-4">
          <Card title="Summary">
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/60">Status</dt>
                <dd><CreditNoteStatusBadge status={status} /></dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Amount</dt>
                <dd className="font-bold text-navy">{fmt.format(Number(cn.amount))}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Issue Date</dt>
                <dd className="text-navy">{fmtDate((cn as any).issueDate ?? cn.createdAt)}</dd>
              </div>
              {cn.invoiceId && (
                <div className="flex justify-between">
                  <dt className="text-navy/60">Invoice</dt>
                  <dd>
                    <Link
                      href={`/invoices/${cn.invoiceId}`}
                      className="text-brand-600 hover:underline text-xs font-mono"
                    >
                      {cn.invoiceId}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>

            {status === "DRAFT" && (
              <div className="mt-4 space-y-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  leftIcon={<Send className="h-4 w-4" />}
                  onClick={handleIssue}
                  loading={issueCreditNote.isPending}
                >
                  Issue Credit Note
                </Button>
              </div>
            )}

            {status === "ISSUED" && (
              <div className="mt-4 space-y-2">
                <Button
                  size="sm"
                  className="w-full"
                  leftIcon={<CheckCircle2 className="h-4 w-4" />}
                  onClick={() => setIsApplyOpen(true)}
                >
                  Apply to Invoice
                </Button>
              </div>
            )}
          </Card>

          <Card title="Audit">
            <dl className="space-y-2 text-xs text-navy/60">
              <div className="flex justify-between">
                <dt>Created</dt>
                <dd>{fmtDate(cn.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Last Updated</dt>
                <dd>{fmtDate(cn.updatedAt)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      {/* Modals */}
      <VoidConfirmModal
        isOpen={isVoidOpen}
        onClose={() => setIsVoidOpen(false)}
        onConfirm={handleVoid}
        cnNumber={cn.creditNoteNumber}
        isPending={voidCreditNote.isPending}
      />

      <ApplyToInvoiceModal
        isOpen={isApplyOpen}
        onClose={() => setIsApplyOpen(false)}
        onApply={handleApply}
        customerId={cn.customerId}
        isPending={applyCreditNote.isPending}
      />
    </div>
  );
}
