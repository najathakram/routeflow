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
  Zap,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { Button, Badge, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useCreditNote,
  useIssueCreditNote,
  useApplyCreditNote,
  useVoidCreditNote,
  useUpdateCreditNote,
} from "@/lib/api/credit-notes";
import { useInvoices } from "@/lib/api/invoices";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { DocumentLetterhead } from "@/components/DocumentLetterhead";

// ─── Issue confirm modal ──────────────────────────────────────────────────────

function IssueConfirmModal({
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
      title="Issue Credit Note?"
      description={`Issue credit note ${cnNumber}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={isPending}>
            Issue Credit Note
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        Once issued, this credit note can be applied to an open invoice or voided. It can no longer
        be edited.
      </p>
    </Modal>
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

  // Scope by customer SERVER-side. This used to fetch the newest 100 invoices
  // TENANT-WIDE and filter client-side, so a customer whose invoices fell
  // outside that page got an empty list — the `<select>` never rendered, yet
  // submit still demanded an invoice ("asks for the invoice number, there's no
  // place to add it"). The sibling create modal already does it this way, and
  // so does mobile's picker.
  const { data: invoicesData, isLoading: invoicesLoading } = useInvoices({
    customerId,
    limit: 100,
  });
  const invoices = React.useMemo(() => {
    const all = invoicesData?.data ?? [];
    // Mirror the server's actual rule (credit-notes.service.ts rejects only
    // PAID / VOID / WRITTEN_OFF) rather than an allow-list. The old list also
    // hid DRAFT, so a customer whose only open invoice was a draft hit the
    // same dead end even once the query was scoped.
    return all.filter(
      (inv) => inv.status !== "PAID" && inv.status !== "VOID" && inv.status !== "WRITTEN_OFF",
    );
  }, [invoicesData]);

  React.useEffect(() => {
    if (isOpen) {
      setSelectedInvoiceId("");
      setError("");
    }
  }, [isOpen]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedInvoiceId) {
      setError("Select an invoice to apply this credit note to.");
      return;
    }
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
          {/* Never leave an enabled submit above a control that isn't there. */}
          <Button
            type="submit"
            form="apply-cn-form"
            loading={isPending}
            disabled={invoicesLoading || invoices.length === 0}
          >
            Apply Credit Note
          </Button>
        </>
      }
    >
      <form id="apply-cn-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Invoice</label>
          {invoicesLoading ? (
            <p className="text-sm text-navy/70">Loading invoices…</p>
          ) : invoices.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-navy/70">
                This customer has no open invoices, so there is nothing to apply this credit note
                against yet. It stays available and will be applied automatically to their next
                invoice.
              </p>
              {/* The customer page has an Invoices tab; /invoices has no
                  customerId filter, so linking there would silently ignore it. */}
              <Link
                href={`/customers/${customerId}`}
                className="inline-block text-sm font-medium text-brand-600 hover:underline"
              >
                View this customer&apos;s invoices
              </Link>
            </div>
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
                  {inv.invoiceNumber} — {fmt(Number(inv.balanceDue))} due ({inv.status})
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
  const updateCreditNote = useUpdateCreditNote();

  const [isIssueOpen, setIsIssueOpen] = React.useState(false);
  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isApplyOpen, setIsApplyOpen] = React.useState(false);
  // Inline reason edit — editable at ANY status (descriptive text).
  const [isEditingReason, setIsEditingReason] = React.useState(false);
  const [reasonDraft, setReasonDraft] = React.useState("");

  React.useEffect(() => {
    if (cn) setTitle(cn.creditNoteNumber);
  }, [cn, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
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

  // P5-13: remaining balance + expiry — canonical predicate mirrors the API's
  // `amount - amountUsed` / computed-expiry filter. Applying is gated on !isExpired
  // regardless of status (an expired ISSUED note can never be applied again).
  const remaining = Number(cn.amount) - Number(cn.amountUsed ?? 0);
  const isExpired = !!cn.expiresAt && new Date(cn.expiresAt).getTime() <= Date.now();
  const canApply = status === "ISSUED" && !isExpired;

  // ── Action handlers ──────────────────────────────────────────────────────────

  const handleIssue = () => {
    setIsIssueOpen(false);
    issueCreditNote.mutate(cn.id, {
      onSuccess: () => {
        toast({
          title: "Credit note issued",
          description: `${cn.creditNoteNumber} has been issued.`,
          variant: "success",
        });
      },
      onError: () => {
        toast({
          title: "Failed to issue credit note",
          description: "Please try again.",
          variant: "error",
        });
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
        toast({
          title: "Failed to void credit note",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleSaveReason = () => {
    const reason = reasonDraft.trim();
    if (!reason) return;
    updateCreditNote.mutate(
      { id: cn.id, reason },
      {
        onSuccess: () => {
          setIsEditingReason(false);
          toast({ title: "Reason updated", variant: "success" });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to update reason",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
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
        onError: (err: unknown) => {
          // Surface the server's message, as mobile does. The apply endpoint
          // returns four actionable ones ("Cannot apply credit note to invoice
          // with status X", "…different customers", "…no remaining balance",
          // "Credit note has expired") and all of them were being swallowed in
          // favour of a fixed "Please try again."
          const message = (err as { response?: { data?: { message?: string } } })?.response?.data
            ?.message;
          toast({
            title: "Failed to apply credit note",
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
        href="/credit-notes"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Credit Notes
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-navy">{cn.creditNoteNumber}</h2>
          <Badge status={status} />
          {cn.autoApplied && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2 py-0.5 text-[11px] font-medium text-brand-600">
              <Zap className="h-3 w-3" /> Auto-applied
            </span>
          )}
          {isExpired && (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
              <AlertTriangle className="h-3 w-3" /> Expired
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {status === "DRAFT" && (
            <>
              <Button
                size="sm"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={() => setIsIssueOpen(true)}
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
                disabled={!canApply}
                title={
                  isExpired
                    ? "This credit note has expired and can no longer be applied."
                    : undefined
                }
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
            <span className="text-sm italic text-navy/70">
              {status === "APPLIED"
                ? "This credit note has been applied."
                : "This credit note is void."}
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
                <DocumentLetterhead />
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-navy">CREDIT NOTE</p>
                <p className="mt-1 font-mono text-sm text-navy/70">{cn.creditNoteNumber}</p>
              </div>
            </div>

            {/* Customer + Dates */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Credit To
                </p>
                <p className="text-sm font-semibold text-navy">
                  {cn.customer?.businessName ?? "—"}
                </p>
                {cn.customer?.contactName && (
                  <p className="text-sm text-navy/70">{cn.customer.contactName}</p>
                )}
                {cn.customer?.address && (
                  <p className="mt-1 text-xs text-navy/70 whitespace-pre-line">
                    {cn.customer.address}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Details
                </p>
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Issue Date:</span>{" "}
                  {fmtCalendarDate(cn.issueDate ?? cn.createdAt)}
                </p>
                {cn.invoiceId && (
                  <p className="mt-1 text-sm text-navy/70">
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
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Credit Amount
                  </p>
                  <p className="mt-1 text-3xl font-bold text-navy">{fmt(Number(cn.amount))}</p>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                  <FileText className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </div>

            {/* Reason — editable at ANY status; rendered live via the relation
                everywhere it's shown (order/invoice/PDF), so this edit is the
                one place it needs to be changed. */}
            <div className="mt-6 border-t border-surface-border pt-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Reason
                </p>
                {!isEditingReason && (
                  <button
                    type="button"
                    onClick={() => {
                      setReasonDraft(cn.reason);
                      setIsEditingReason(true);
                    }}
                    className="rounded p-1 text-navy/40 hover:text-brand-500 transition-colors"
                    title="Edit reason"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {isEditingReason ? (
                <div className="space-y-2">
                  <textarea
                    rows={2}
                    value={reasonDraft}
                    onChange={(e) => setReasonDraft(e.target.value)}
                    className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditingReason(false)}
                      disabled={updateCreditNote.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      loading={updateCreditNote.isPending}
                      disabled={!reasonDraft.trim()}
                      onClick={handleSaveReason}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-navy/80 whitespace-pre-line">{cn.reason}</p>
              )}
            </div>

            {/* Notes */}
            {cn.notes && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
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
                <dt className="text-navy/70">Status</dt>
                <dd>
                  <Badge status={status} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Amount</dt>
                <dd className="font-bold text-navy">{fmt(Number(cn.amount))}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Applied</dt>
                <dd className="text-navy">{fmt(Number(cn.amountUsed ?? 0))}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Remaining</dt>
                <dd className={`font-semibold ${remaining > 0.001 ? "text-navy" : "text-navy/40"}`}>
                  {fmt(Math.max(remaining, 0))}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Issue Date</dt>
                <dd className="text-navy">{fmtCalendarDate(cn.issueDate ?? cn.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/70">Expires</dt>
                <dd className={isExpired ? "font-medium text-danger" : "text-navy"}>
                  {cn.expiresAt ? fmtCalendarDate(cn.expiresAt) : "Never"}
                </dd>
              </div>
              {cn.invoiceId && (
                <div className="flex justify-between">
                  <dt className="text-navy/70">Invoice</dt>
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
                  onClick={() => setIsIssueOpen(true)}
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
                  disabled={!canApply}
                >
                  Apply to Invoice
                </Button>
                {isExpired && (
                  <p className="text-xs text-danger">
                    This credit note expired and can no longer be applied.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="Audit">
            <dl className="space-y-2 text-xs text-navy/70">
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
      <IssueConfirmModal
        isOpen={isIssueOpen}
        onClose={() => setIsIssueOpen(false)}
        onConfirm={handleIssue}
        cnNumber={cn.creditNoteNumber}
        isPending={issueCreditNote.isPending}
      />

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
