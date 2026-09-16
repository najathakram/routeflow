"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Send,
  CreditCard,
  Download,
  Printer,
  Copy,
  Ban,
  Loader2,
  CheckCircle2,
  Pencil,
  Trash2,
  AlertTriangle,
  XCircle,
  MoreHorizontal,
  ChevronDown,
  Info,
  AlertCircle,
  CheckCheck,
  BookOpen,
  RotateCcw,
  Package,
  SlidersHorizontal,
  Paperclip,
  Eye,
  Upload,
  X,
  Clock,
  Wallet,
} from "lucide-react";
import { Badge, Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useInvoice,
  useSendInvoice,
  useSendInvoiceEmail,
  useSendInvoiceReminder,
  useVoidInvoice,
  useReopenInvoice,
  useRecordInvoicePayment,
  useCreateInvoice,
  useWriteOffInvoice,
  useUpdateInvoicePayment,
  useDeleteInvoicePayment,
  useUploadPaymentImage,
  useDeletePaymentImage,
  useGetPaymentImageUrl,
  useDownloadInvoicePdf,
  type InvoicePdfVariant,
  deriveInvoiceVariant,
  useRevertInvoiceToDraft,
  useUnvoidInvoice,
  useAdjustInvoicePrices,
  useUpdateInvoiceShipment,
  useUpdateInvoiceTerms,
  useSetCheckStatus,
  useApplyAdvanceToInvoice,
  type Invoice,
  type InvoiceStatus,
  type InvoicePayment,
  type CheckStatus,
} from "@/lib/api/invoices";
import { useParams, useRouter } from "next/navigation";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { useUnapplyCreditNote } from "@/lib/api/credit-notes";
import { useCustomerAdvancePayments } from "@/lib/api/customers";
import { fmt, fmtCalendarDate, fmtDate, isInternalEmail, todayIso } from "@/lib/formatting";
import { getDaysForTerms, addDaysIso } from "@/lib/invoice-terms";
import { formatQtySplit, remainingCapacity, resolveConfirmedAmounts } from "@routeflow/pricing";
import { CHECK_TRANSITIONS } from "@routeflow/types";
import { InvoiceTotalsSummary } from "./InvoiceTotalsSummary";
import {
  SELECTABLE_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_COLORS,
  paymentMethodLabel,
  type AnyPaymentMethod,
  type SelectablePaymentMethod,
} from "@/lib/payment-methods";
import { TenantLogo } from "@/components/TenantLogo";
import { ShipmentCard } from "@/components/ShipmentCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useTenant } from "@/components/tenant-provider";
import { useAuth } from "@/lib/auth-context";
import { OrderPreviewModal } from "../../_components/LinkedDocPreviewModal";
import { printPdfBlob } from "@/lib/print-pdf-blob";

// ─── Credit-note relation on a payment row ─────────────────────────────────────
// WP2 (invoices.service.ts findOne) includes `creditNote: {id, creditNoteNumber,
// reason, ...}` on CREDIT_NOTE payments. The shared `InvoicePayment` type
// (lib/api/invoices.ts) isn't part of this package's file set, so read it via a
// local, narrowly-typed cast rather than widening that shared interface here.
interface PaymentCreditNoteInfo {
  id: string;
  creditNoteNumber: string;
  reason?: string | null;
}

function creditNoteOf(pmt: InvoicePayment): PaymentCreditNoteInfo | null {
  const withCn = pmt as unknown as { creditNote?: PaymentCreditNoteInfo | null };
  return withCn.creditNote ?? null;
}

const methodLabel = paymentMethodLabel;

function methodBadgeClass(method: string) {
  return PAYMENT_METHOD_COLORS[method as AnyPaymentMethod] ?? "bg-gray-100 text-gray-600";
}

// ─── Check lifecycle (Recorded → Deposited → Cleared → Bounced) ───────────────

// P5-12 / post-dated check payments PR-1: `CHECK_TRANSITIONS` (legal FORWARD transitions for a
// CHECK payment, so the dropdown greys out illegal jumps before the request round-trips) now
// comes from `@routeflow/types` — the ONE canonical copy shared with the API
// (`invoices.service.ts`) and mobile (`payments-logic.ts`), which used to each hand-maintain an
// identical local const. See `packages/types/api/checks.ts` for the V1-only rule.

const CHECK_STATUS_META: Record<CheckStatus, { label: string; className: string }> = {
  RECORDED: { label: "Check recorded", className: "bg-gray-100 text-gray-600" },
  DEPOSITED: { label: "Deposited", className: "bg-blue-100 text-blue-700" },
  CLEARED: { label: "Cleared", className: "bg-success-bg text-success" },
  BOUNCED: { label: "Bounced (NSF)", className: "bg-danger/10 text-danger" },
};

/**
 * Where a CHECK payment sits in its lifecycle. `null` on non-check payments,
 * and also on a payment that was manually voided (via the pre-P5-12
 * void-payment action) rather than through the bounce flow — we can't know
 * whether it bounced, so no badge is shown rather than guessing RECORDED.
 */
function effectiveCheckStatus(pmt: InvoicePayment): CheckStatus | null {
  if (pmt.method !== "CHECK") return null;
  if (pmt.checkStatus) return pmt.checkStatus;
  if (pmt.status === "VOID") return null;
  return "RECORDED";
}

function CheckStatusBadge({ status }: { status: CheckStatus }) {
  const meta = CHECK_STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        meta.className,
      )}
    >
      {status === "BOUNCED" && <XCircle className="h-3 w-3" />}
      {status === "CLEARED" && <CheckCircle2 className="h-3 w-3" />}
      {meta.label}
    </span>
  );
}

/**
 * F03/R2 (REG-B11) — a payment recorded with `status: "DRAFT"` has NOT been
 * confirmed and is excluded from every CONFIRMED_PAYMENT sum on the server
 * (balanceDue, dashboards, PDF, email — invoices.service.ts's payment
 * predicate). Money still owed can otherwise look paid here, so the row must
 * say so instead of rendering identically to a confirmed payment.
 */
function DraftPaymentBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
      title="Not yet confirmed — this amount is not counted toward the balance due"
    >
      <Clock className="h-3 w-3" />
      Draft — unconfirmed
    </span>
  );
}

// ─── Status ribbon (diagonal corner badge on invoice doc) ─────────────────────

function StatusRibbon({ status }: { status: InvoiceStatus }) {
  if (status === "DRAFT") return null;

  const ribbonStyle: Record<string, { bg: string; text: string; label: string }> = {
    SENT: { bg: "bg-teal-500", text: "text-white", label: "Sent" },
    VIEWED: { bg: "bg-purple-500", text: "text-white", label: "Viewed" },
    PARTIAL: { bg: "bg-yellow-500", text: "text-white", label: "Partial" },
    PAID: { bg: "bg-green-500", text: "text-white", label: "Paid" },
    VOID: { bg: "bg-red-500", text: "text-white", label: "Void" },
    OVERDUE: { bg: "bg-red-500", text: "text-white", label: "Overdue" },
    WRITTEN_OFF: { bg: "bg-stone-500", text: "text-white", label: "Written Off" },
  };

  const r = ribbonStyle[status];
  if (!r) return null;

  return (
    <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 overflow-hidden">
      <div
        className={cn(
          "absolute right-[-28px] top-[18px] w-[120px] rotate-45 py-1 text-center text-xs font-bold tracking-wider shadow-sm",
          r.bg,
          r.text,
        )}
      >
        {r.label.toUpperCase()}
      </div>
    </div>
  );
}

// ─── "What's Next" guidance banner ────────────────────────────────────────────

function WhatsNextBanner({
  status,
  onRecordPayment,
}: {
  status: InvoiceStatus;
  onRecordPayment: () => void;
}) {
  if (status === "DRAFT") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <p className="text-sm text-blue-700">
          Review this invoice and send it to your customer when ready.
        </p>
      </div>
    );
  }

  if (status === "SENT" || status === "VIEWED") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
          <p className="text-sm text-blue-700">
            <strong>Invoice has been sent.</strong> Record payment as soon as you receive it.
          </p>
        </div>
        <Button size="sm" onClick={onRecordPayment} leftIcon={<CreditCard className="h-4 w-4" />}>
          Record Payment
        </Button>
      </div>
    );
  }

  if (status === "PARTIAL") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <p className="text-sm text-yellow-700">
            <strong>Partial payment received.</strong> Follow up for the remaining balance.
          </p>
        </div>
        <Button size="sm" onClick={onRecordPayment} leftIcon={<CreditCard className="h-4 w-4" />}>
          Record Payment
        </Button>
      </div>
    );
  }

  if (status === "OVERDUE") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
          <p className="text-sm text-orange-700">
            <strong>This invoice is overdue.</strong> Contact your customer for payment.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onRecordPayment}
          leftIcon={<CreditCard className="h-4 w-4" />}
          className="border-orange-300 text-orange-700 hover:bg-orange-100"
        >
          Record Payment
        </Button>
      </div>
    );
  }

  if (status === "PAID") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
        <CheckCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
        <p className="text-sm text-green-700">
          <strong>Invoice has been paid in full.</strong>
        </p>
      </div>
    );
  }

  if (status === "WRITTEN_OFF") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-stone-500" />
        <p className="text-sm text-stone-600">This invoice has been written off.</p>
      </div>
    );
  }

  return null;
}

// ─── Record payment modal ─────────────────────────────────────────────────────

interface PaymentFormState {
  method: SelectablePaymentMethod;
  amount: string;
  /** YYYY-MM-DD. */
  paidAt: string;
  /** YYYY-MM-DD, empty when unknown. Never capped — a post-dated check settles in the future. */
  settledAt: string;
  reference: string;
  notes: string;
}

const BANK_DATE_LABEL = "Money received in bank";
const BANK_DATE_HELP =
  "When the funds actually landed in your account — e.g. a post-dated check's clearing date. Leave blank if unknown.";

/** YYYY-MM-DD slice of a stored timestamp, for a native date input. */
function dateInputValue(iso?: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function RecordPaymentModal({
  isOpen,
  onClose,
  onRecord,
  balanceDue,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onRecord: (data: PaymentFormState, file: File | null) => void;
  balanceDue: number;
  isPending: boolean;
}) {
  const [form, setForm] = React.useState<PaymentFormState>({
    method: "ACH",
    amount: "",
    paidAt: todayIso(),
    settledAt: "",
    reference: "",
    notes: "",
  });
  const [amountError, setAmountError] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isOpen) {
      setForm({
        method: "ACH",
        amount: balanceDue > 0 ? balanceDue.toFixed(2) : "",
        paidAt: todayIso(),
        settledAt: "",
        reference: "",
        notes: "",
      });
      setAmountError("");
      setFile(null);
    }
  }, [isOpen, balanceDue]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if (!form.amount || isNaN(amt) || amt <= 0) {
      setAmountError("Enter an amount greater than 0.");
      return;
    }
    setAmountError("");
    onRecord(form, file);
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Record Payment"
      description="Log a payment received for this invoice."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="invoice-payment-form" loading={isPending}>
            Record Payment
          </Button>
        </>
      }
    >
      <form id="invoice-payment-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment Method</label>
          <select
            value={form.method}
            onChange={(e) =>
              setForm((f) => ({ ...f, method: e.target.value as PaymentFormState["method"] }))
            }
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {SELECTABLE_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Amount Received ($)
          </label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              amountError ? "border-danger" : "border-surface-border",
            )}
          />
          {amountError && <p className="mt-1 text-xs text-danger">{amountError}</p>}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment date</label>
          <input
            type="date"
            value={form.paidAt}
            onChange={(e) => setForm((f) => ({ ...f, paidAt: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <label className="mb-1.5 mt-3 block text-sm font-medium text-navy/60">
            {BANK_DATE_LABEL} (optional)
          </label>
          <input
            type="date"
            value={form.settledAt}
            onChange={(e) => setForm((f) => ({ ...f, settledAt: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-navy/50">{BANK_DATE_HELP}</p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Reference # (optional)
          </label>
          <input
            type="text"
            placeholder="Check number, ACH ID…"
            value={form.reference}
            onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Notes (optional)</label>
          <textarea
            rows={2}
            placeholder="Additional payment notes…"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Attach image (optional)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy">
              <span className="flex min-w-0 items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-navy/70" />
                <span className="truncate">{file.name}</span>
              </span>
              <button
                type="button"
                onClick={() => setFile(null)}
                className="shrink-0 text-navy/50 transition-colors hover:text-danger"
                title="Remove attachment"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-surface-border bg-white px-3 py-2 text-sm text-navy/70 transition-colors hover:bg-surface-raised"
            >
              <Paperclip className="h-3.5 w-3.5" />
              Attach receipt / check photo
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ─── Apply advance modal (B13) ─────────────────────────────────────────────────

/**
 * Lists the customer's advance-payment wallet rows with a remaining balance
 * and applies the picked one to this invoice — mirrors mobile's
 * ApplyAdvanceSheet (apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx), the
 * first client for this action. The server caps the applied amount at
 * min(wallet balance, invoice balance) and writes the InvoicePayment
 * (method ADVANCE, reference AP-<id8>); the client does no money math.
 */
function ApplyAdvanceModal({
  isOpen,
  onClose,
  customerId,
  invoiceId,
  invoiceNumber,
}: {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
}) {
  const { toast } = useToast();
  const { data, isLoading } = useCustomerAdvancePayments(customerId);
  const applyAdvance = useApplyAdvanceToInvoice();
  const open = (data ?? []).filter((ap) => Number(ap.balance) > 0.001);

  // F7 (money discipline): the client does no money math — the server caps the
  // applied amount at min(wallet balance, invoice balance) and is the only source of
  // truth for what actually landed (the mutation resolves the server's own
  // `appliedAmount`, reported in the success toast below).
  const handleApply = (advancePaymentId: string) => {
    if (
      !window.confirm(
        `Apply advance AP-${advancePaymentId.slice(0, 8)}? Up to the invoice's outstanding balance will be applied.`,
      )
    ) {
      return;
    }
    applyAdvance.mutate(
      { customerId, advancePaymentId, invoiceId },
      {
        onSuccess: (updated) => {
          toast({
            title: "Advance applied",
            description: `${fmt(updated.appliedAmount)} applied to ${invoiceNumber}.`,
            variant: "success",
          });
          onClose();
        },
        onError: (e: any) =>
          toast({
            title: "Could not apply advance",
            description: e?.response?.data?.message ?? e?.message ?? "Try again.",
            variant: "error",
          }),
      },
    );
  };

  return (
    <Modal open={isOpen} onClose={onClose} title="Apply advance">
      {isLoading ? (
        <p className="py-6 text-center text-sm text-navy/60">Loading…</p>
      ) : open.length === 0 ? (
        <p className="py-6 text-center text-sm text-navy/60">
          No advance balance for this customer. Record one from the customer page, or an overpaid
          standalone payment creates one automatically.
        </p>
      ) : (
        <div className="space-y-2">
          {open.map((ap) => {
            const remaining = Number(ap.balance) || 0;
            return (
              <button
                key={ap.id}
                type="button"
                disabled={applyAdvance.isPending}
                onClick={() => handleApply(ap.id)}
                className="flex w-full items-center justify-between rounded-lg border border-surface-border bg-white px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                <span className="flex items-center gap-2 text-navy/80">
                  <Wallet className="h-3.5 w-3.5 text-navy/50" />
                  {ap.reference || `Advance · ${fmtDate(ap.createdAt)}`}
                </span>
                <span className="font-medium text-navy">{fmt(remaining)}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ─── Edit payment modal ───────────────────────────────────────────────────────

function EditPaymentModal({
  isOpen,
  onClose,
  onSave,
  payment,
  maxAmount,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: PaymentFormState) => void;
  payment: InvoicePayment | null;
  maxAmount: number;
  isPending: boolean;
}) {
  const { toast } = useToast();
  const [form, setForm] = React.useState<PaymentFormState>({
    method: "ACH",
    amount: "",
    paidAt: todayIso(),
    settledAt: "",
    reference: "",
    notes: "",
  });
  const [amountError, setAmountError] = React.useState("");
  const imageFileInputRef = React.useRef<HTMLInputElement>(null);
  const uploadPaymentImage = useUploadPaymentImage();
  const deletePaymentImage = useDeletePaymentImage();
  const getPaymentImageUrl = useGetPaymentImageUrl();

  React.useEffect(() => {
    if (isOpen && payment) {
      setForm({
        method: payment.method as PaymentFormState["method"],
        amount: Number(payment.amount).toFixed(2),
        paidAt: dateInputValue(payment.paidAt ?? payment.createdAt),
        settledAt: dateInputValue(payment.settledAt),
        reference: payment.reference ?? "",
        notes: payment.notes ?? "",
      });
      setAmountError("");
    }
  }, [isOpen, payment]);

  function handleViewImage() {
    if (!payment) return;
    getPaymentImageUrl.mutate(payment.id, {
      onSuccess: (res) => window.open(res.url, "_blank", "noopener,noreferrer"),
      onError: () => toast({ title: "Failed to load image", variant: "error" }),
    });
  }

  function handleReplaceImage(newFile: File) {
    if (!payment) return;
    uploadPaymentImage.mutate(
      { paymentId: payment.id, file: newFile },
      {
        onSuccess: () => toast({ title: "Image updated", variant: "success" }),
        onError: () => toast({ title: "Failed to upload image", variant: "error" }),
      },
    );
  }

  function handleRemoveImage() {
    if (!payment) return;
    deletePaymentImage.mutate(payment.id, {
      onSuccess: () => toast({ title: "Image removed", variant: "success" }),
      onError: () => toast({ title: "Failed to remove image", variant: "error" }),
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if (!form.amount || isNaN(amt) || amt <= 0) {
      setAmountError("Enter an amount greater than 0.");
      return;
    }
    if (amt > maxAmount + 0.001) {
      setAmountError(`Amount cannot exceed remaining balance of ${fmt(maxAmount)}.`);
      return;
    }
    setAmountError("");
    onSave(form);
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Edit Payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="edit-payment-form" loading={isPending}>
            Save Changes
          </Button>
        </>
      }
    >
      <form id="edit-payment-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment Method</label>
          <select
            value={form.method}
            onChange={(e) =>
              setForm((f) => ({ ...f, method: e.target.value as PaymentFormState["method"] }))
            }
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {SELECTABLE_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Amount ($)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              amountError ? "border-danger" : "border-surface-border",
            )}
          />
          {amountError && <p className="mt-1 text-xs text-danger">{amountError}</p>}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment date</label>
          <input
            type="date"
            value={form.paidAt}
            onChange={(e) => setForm((f) => ({ ...f, paidAt: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <label className="mb-1.5 mt-3 block text-sm font-medium text-navy/60">
            {BANK_DATE_LABEL} (optional)
          </label>
          <input
            type="date"
            value={form.settledAt}
            onChange={(e) => setForm((f) => ({ ...f, settledAt: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-navy/50">{BANK_DATE_HELP}</p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Reference # (optional)
          </label>
          <input
            type="text"
            value={form.reference}
            onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Notes (optional)</label>
          <textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </form>

      {/* Receipt image — View / Replace / Remove act immediately (the payment
          already exists), independent of the Save Changes button above. */}
      <div className="mt-4 space-y-2 border-t border-surface-border pt-4">
        <label className="block text-sm font-medium text-navy/80">Receipt image</label>
        <input
          ref={imageFileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const newFile = e.target.files?.[0];
            e.target.value = "";
            if (newFile) handleReplaceImage(newFile);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {payment?.imageKey ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leftIcon={<Eye className="h-3.5 w-3.5" />}
                onClick={handleViewImage}
                loading={getPaymentImageUrl.isPending}
              >
                View
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leftIcon={<Upload className="h-3.5 w-3.5" />}
                onClick={() => imageFileInputRef.current?.click()}
                loading={uploadPaymentImage.isPending}
              >
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={handleRemoveImage}
                loading={deletePaymentImage.isPending}
                className="text-danger"
              >
                Remove
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leftIcon={<Paperclip className="h-3.5 w-3.5" />}
              onClick={() => imageFileInputRef.current?.click()}
              loading={uploadPaymentImage.isPending}
            >
              Attach image
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Void confirm modal ───────────────────────────────────────────────────────

function VoidConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  invoiceNumber,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  invoiceNumber: string;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Void Invoice?"
      description={`Invoice ${invoiceNumber} will be marked as void. This action cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isPending}>
            Void Invoice
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        Voiding this invoice will mark it as cancelled. No further payments can be recorded on it.
      </p>
    </Modal>
  );
}

// ─── Write-off modal ──────────────────────────────────────────────────────────

function WriteOffModal({
  isOpen,
  onClose,
  onConfirm,
  invoiceNumber,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  invoiceNumber: string;
  isPending: boolean;
}) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (isOpen) {
      setReason("");
      setError("");
    }
  }, [isOpen]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Please provide a reason for writing off this invoice.");
      return;
    }
    setError("");
    onConfirm(reason.trim());
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Write Off Invoice"
      description={`Mark invoice ${invoiceNumber} as uncollectible (bad debt).`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" form="write-off-form" loading={isPending}>
            Write Off
          </Button>
        </>
      }
    >
      <form id="write-off-form" onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg bg-yellow-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <p className="text-sm text-yellow-800">
            Writing off an invoice marks the remaining balance as uncollectible. This action cannot
            be undone.
          </p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Reason *</label>
          <textarea
            rows={3}
            placeholder="e.g. Customer declared bankruptcy, debt too old to collect…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={cn(
              "w-full resize-none rounded-lg border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              error ? "border-danger" : "border-surface-border",
            )}
          />
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      </form>
    </Modal>
  );
}

// ─── Edit terms modal (WP3 PATCH /invoices/:id/terms) ─────────────────────────
// Same TERMS_OPTIONS values as invoices/new/page.tsx and the DRAFT edit page —
// kept local since none of the three share a lib module for it.
const EDIT_TERMS_OPTIONS = [
  { value: "", label: "Select terms…" },
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

interface EditTermsFields {
  dueDate?: string;
  paymentTermsLabel?: string;
  referenceNumber?: string;
  subject?: string;
}

function EditTermsModal({
  isOpen,
  onClose,
  onConfirm,
  invoice,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (fields: EditTermsFields) => void;
  invoice: Invoice;
  isPending: boolean;
}) {
  const [dueDate, setDueDate] = React.useState("");
  const [paymentTermsLabel, setPaymentTermsLabel] = React.useState("");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [subject, setSubject] = React.useState("");

  React.useEffect(() => {
    if (!isOpen) return;
    setDueDate(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
    setPaymentTermsLabel(invoice.paymentTermsLabel ?? "");
    setReferenceNumber(invoice.referenceNumber ?? "");
    setSubject(invoice.subject ?? "");
  }, [isOpen, invoice]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm({
      // dueDate stays undefined-when-empty: the DTO takes an ISO date and this
      // modal never clears a due date.
      dueDate: dueDate || undefined,
      // The three text fields are sent even when empty: "" is how this modal
      // CLEARS a stale label / reference / subject (the server maps it to null,
      // same convention as the DRAFT edit page and the customer/supplier
      // default-terms selects). Collapsing them to undefined would make the
      // server treat a deliberately blanked field as "leave unchanged" and the
      // old value would reappear on the next refetch.
      paymentTermsLabel,
      referenceNumber: referenceNumber.trim(),
      subject: subject.trim(),
    });
  }

  const inputCls =
    "h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Edit Terms"
      description={`Correct the due date, payment terms, reference, or subject on invoice ${invoice.invoiceNumber}. Line items, discounts, and payments are untouched.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="edit-terms-form" loading={isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-terms-form" onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Due Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Terms</label>
            <select
              value={paymentTermsLabel}
              onChange={(e) => {
                const label = e.target.value;
                setPaymentTermsLabel(label);
                // The client-reported bug: changing the term used to leave the old due
                // date in place, persisting "Net 60" over Net-30 arithmetic. A known term
                // recomputes from the ISSUE date (the anchor the server itself uses);
                // picking "Select terms…" leaves the date alone for a manual correction.
                const days = getDaysForTerms(label);
                if (days != null && invoice.issueDate) {
                  setDueDate(addDaysIso(String(invoice.issueDate).slice(0, 10), days));
                }
              }}
              className={inputCls}
            >
              {EDIT_TERMS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* Only promise the recalculation when there IS an issue date to anchor
            it — the onChange above is a no-op without one, so the copy would
            otherwise describe behavior the user cannot get. */}
        {invoice.issueDate ? (
          <p className="text-xs text-navy/50">
            Picking a term recalculates the due date from the issue date (
            {fmtCalendarDate(invoice.issueDate)}).
          </p>
        ) : null}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Reference / PO Number
          </label>
          <input
            type="text"
            value={referenceNumber}
            onChange={(e) => setReferenceNumber(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={inputCls}
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Delete payment confirm modal ─────────────────────────────────────────────

function DeletePaymentModal({
  isOpen,
  onClose,
  onConfirm,
  amount,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  amount: number;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Delete Payment?"
      description={`Remove payment of ${fmt(amount)} from this invoice?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isPending}>
            Delete Payment
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        The invoice balance will be updated automatically. This action cannot be undone.
      </p>
    </Modal>
  );
}

// ─── Mark check bounced (NSF) modal ───────────────────────────────────────────

function MarkBouncedModal({
  isOpen,
  onClose,
  onConfirm,
  amount,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (nsfFeeAmount: number) => void;
  amount: number;
  isPending: boolean;
}) {
  const [fee, setFee] = React.useState("");

  React.useEffect(() => {
    if (isOpen) setFee("");
  }, [isOpen]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseFloat(fee);
    onConfirm(!fee || isNaN(parsed) || parsed < 0 ? 0 : parsed);
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Mark Check as Bounced?"
      description={`This check for ${fmt(amount)} will be voided (NSF) and the invoice balance will re-open.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" form="mark-bounced-form" loading={isPending}>
            Mark Bounced
          </Button>
        </>
      }
    >
      <form id="mark-bounced-form" onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg bg-danger/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p className="text-sm text-danger">
            This payment will be voided and no longer counts toward the paid amount. This action
            cannot be undone.
          </p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            NSF Fee ($, optional)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-navy/70">
            Adds a non-taxable fee line to the invoice for the returned-check charge.
          </p>
        </div>
      </form>
    </Modal>
  );
}

// ─── Send-blocked recovery modal (no email on file / email send failed) ───────

function NoEmailModal({
  reason,
  onClose,
  customerName,
  onMarkSent,
  onDownload,
  onPrint,
  isPending,
}: {
  reason: null | { kind: "no-email" } | { kind: "send-failed"; message: string };
  onClose: () => void;
  customerName: string;
  onMarkSent: () => void;
  onDownload: () => void;
  onPrint: () => void;
  isPending: boolean;
}) {
  const sendFailed = reason?.kind === "send-failed";
  return (
    <Modal
      open={reason !== null}
      onClose={onClose}
      title={sendFailed ? "Email failed — invoice not sent" : "No email on file"}
      description={
        sendFailed
          ? `${reason.message} You can download or print the invoice to deliver it another way, and mark it as sent to update its status.`
          : `${customerName} has no email address saved. You can download or print the invoice to send it manually, or mark it as sent to update its status.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            leftIcon={<Printer className="h-4 w-4" />}
            onClick={onPrint}
            disabled={isPending}
          >
            Print
          </Button>
          <Button
            variant="secondary"
            leftIcon={<Download className="h-4 w-4" />}
            onClick={onDownload}
            disabled={isPending}
          >
            Download PDF
          </Button>
          <Button variant="primary" onClick={onMarkSent} loading={isPending}>
            Mark as Sent
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        {sendFailed
          ? "Marking as sent only updates the invoice status — no email goes out."
          : "Add an email address to this customer's profile to send invoices by email in the future."}
      </p>
    </Modal>
  );
}

// ─── Action Toolbar Dropdown ──────────────────────────────────────────────────

function DropdownMenu({
  trigger,
  items,
}: {
  trigger: React.ReactNode;
  items: Array<{ label: string; onClick: () => void; disabled?: boolean; danger?: boolean }>;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              disabled={item.disabled}
              className={cn(
                "flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors",
                item.disabled
                  ? "cursor-not-allowed text-navy/30"
                  : item.danger
                    ? "text-danger hover:bg-danger/5"
                    : "text-navy hover:bg-surface-raised",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Adjust Prices Panel ──────────────────────────────────────────────────────

function AdjustPricesPanel({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { toast } = useToast();
  const adjust = useAdjustInvoicePrices();

  const items = invoice.items ?? [];
  const [prices, setPrices] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((it) => [it.id, String(Number(it.unitPrice).toFixed(2))])),
  );
  const [scope, setScope] = React.useState<"SINGLE" | "ALL_CUSTOMER_SINCE">("SINGLE");
  const [sinceDate, setSinceDate] = React.useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });

  function handleSave() {
    const dto = {
      id: invoice.id,
      items: items.map((it) => ({
        itemId: it.id,
        newUnitPrice:
          parseFloat(prices[it.id] ?? String(Number(it.unitPrice))) || Number(it.unitPrice),
      })),
      scope,
      ...(scope === "ALL_CUSTOMER_SINCE" ? { sinceDate } : {}),
    };
    adjust.mutate(dto, {
      onSuccess: () => {
        toast({
          title: "Prices updated",
          description:
            scope === "SINGLE"
              ? "Invoice prices have been adjusted."
              : "Prices updated across matching invoices.",
          variant: "success",
        });
        onClose();
      },
      onError: (err: any) => {
        toast({
          title: "Failed to adjust prices",
          description: err?.response?.data?.message ?? "Please try again.",
          variant: "error",
        });
      },
    });
  }

  return (
    <Card title="Adjust Prices">
      <p className="mb-4 text-sm text-navy/70">
        Override unit prices on this invoice. Totals will be recalculated and an audit note
        appended.
      </p>

      {/* Per-item price inputs */}
      <div className="mb-5 divide-y divide-surface-border rounded-lg border border-surface-border">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-navy">{item.description}</p>
              <p className="text-xs text-navy/70">
                Qty: {item.qty} · Current:{" "}
                <span className="money">{fmt(Number(item.unitPrice))}</span>
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-navy/70">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={prices[item.id] ?? ""}
                onChange={(e) => setPrices((p) => ({ ...p, [item.id]: e.target.value }))}
                className="w-28 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Scope */}
      <div className="mb-5 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Scope</p>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="radio"
            name="adjust-scope"
            checked={scope === "SINGLE"}
            onChange={() => setScope("SINGLE")}
            className="accent-brand-500"
          />
          <span className="text-sm text-navy">This invoice only</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="radio"
            name="adjust-scope"
            checked={scope === "ALL_CUSTOMER_SINCE"}
            onChange={() => setScope("ALL_CUSTOMER_SINCE")}
            className="accent-brand-500"
          />
          <span className="text-sm text-navy">
            All invoices for <strong>{invoice.customer?.businessName ?? "this customer"}</strong>{" "}
            from:
          </span>
        </label>
        {scope === "ALL_CUSTOMER_SINCE" && (
          <div className="ml-6 mt-1">
            <input
              type="date"
              value={sinceDate}
              onChange={(e) => setSinceDate(e.target.value)}
              className="h-9 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/70">
              All matching invoices created on or after this date will be updated.
            </p>
          </div>
        )}
      </div>

      {scope === "ALL_CUSTOMER_SINCE" && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          Bulk update will modify all open invoices for this customer from the selected date. This
          cannot be undone.
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={adjust.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          loading={adjust.isPending}
          leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}
        >
          Apply Price Changes
        </Button>
      </div>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: invoice, isLoading, isError } = useInvoice(id);
  // Sourced from the invoice payload, NOT useInvoiceSettings(): /settings/invoice
  // is operator-only, and CUSTOMER-role users view this same document — the very
  // audience the tenant is hiding the struck-through original price from.
  const hideOriginal = invoice?.hideOriginalPrice === true;
  const sendInvoice = useSendInvoice();
  const sendInvoiceEmail = useSendInvoiceEmail();
  const sendInvoiceReminder = useSendInvoiceReminder();
  const voidInvoice = useVoidInvoice();
  const reopenInvoice = useReopenInvoice();
  const recordPayment = useRecordInvoicePayment();
  const createInvoice = useCreateInvoice();
  const writeOffInvoice = useWriteOffInvoice();
  const updatePayment = useUpdateInvoicePayment();
  const deletePayment = useDeleteInvoicePayment();
  const uploadPaymentImage = useUploadPaymentImage();
  const getPaymentImageUrl = useGetPaymentImageUrl();
  const downloadPdf = useDownloadInvoicePdf();
  const revertToDraft = useRevertInvoiceToDraft();
  const unvoid = useUnvoidInvoice();
  const updateShipment = useUpdateInvoiceShipment();
  const updateTerms = useUpdateInvoiceTerms();
  const setCheckStatus = useSetCheckStatus();
  const unapplyCreditNote = useUnapplyCreditNote();
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";

  const [isPaymentOpen, setIsPaymentOpen] = React.useState(false);
  const [isAdvanceOpen, setIsAdvanceOpen] = React.useState(false);
  // Payment row whose "Remove credit" was clicked — confirm before un-applying.
  const [removingCreditPayment, setRemovingCreditPayment] = React.useState<InvoicePayment | null>(
    null,
  );
  const [showAdjustPanel, setShowAdjustPanel] = React.useState(false);
  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isReopenOpen, setIsReopenOpen] = React.useState(false);
  const [isWriteOffOpen, setIsWriteOffOpen] = React.useState(false);
  const [isEditTermsOpen, setIsEditTermsOpen] = React.useState(false);
  const [isRevertToDraftOpen, setIsRevertToDraftOpen] = React.useState(false);
  const [isUnvoidOpen, setIsUnvoidOpen] = React.useState(false);
  // Why the email path is blocked: no usable address on file, or the server refused
  // the send (EMAIL_SEND_FAILED). Either way the operator gets the same recovery
  // modal — Mark as Sent / Download / Print — instead of a dead-end toast that
  // leaves the invoice stuck in DRAFT (and payments locked).
  const [sendBlocked, setSendBlocked] = React.useState<
    null | { kind: "no-email" } | { kind: "send-failed"; message: string }
  >(null);
  const [editingPayment, setEditingPayment] = React.useState<InvoicePayment | null>(null);
  const [deletingPayment, setDeletingPayment] = React.useState<InvoicePayment | null>(null);
  const [bouncingPayment, setBouncingPayment] = React.useState<InvoicePayment | null>(null);
  // Explicit Draft/Final PDF-stage override; null = follow the smart default.
  const [pdfVariantOverride, setPdfVariant] = React.useState<InvoicePdfVariant | null>(null);
  // Floating "View order" preview popup.
  const [orderPreviewOpen, setOrderPreviewOpen] = React.useState(false);

  React.useEffect(() => {
    if (invoice) setTitle(invoice.invoiceNumber);
  }, [invoice, setTitle]);

  // Regulated SEPARATE_SECTION grouping (T1-16#1): lines whose tracked category is
  // treated as SEPARATE_SECTION are pulled out of the flat list and rendered under
  // a category heading within this same invoice. Everything else (standard +
  // LINE_TAX regulated) stays inline. Display-only — line data/totals unchanged.
  const { data: invTrackedCategories } = useTrackedCategories(
    { active: true },
    { enabled: !!invoice },
  );
  const invCategoryById = React.useMemo(
    () => new Map((invTrackedCategories ?? []).map((c) => [c.id, c])),
    [invTrackedCategories],
  );
  const sectionedRows = React.useMemo(() => {
    const its = invoice?.items ?? [];
    const inline: typeof its = [];
    const sections = new Map<string, { name: string; items: typeof its }>();
    for (const it of its) {
      const cat = it.trackedCategoryId ? invCategoryById.get(it.trackedCategoryId) : undefined;
      if (cat && cat.invoiceTreatment === "SEPARATE_SECTION") {
        const s = sections.get(cat.id) ?? { name: cat.name, items: [] };
        s.items.push(it);
        sections.set(cat.id, s);
      } else {
        inline.push(it);
      }
    }
    const rows: Array<
      { kind: "heading"; label: string } | { kind: "item"; item: (typeof its)[number] }
    > = inline.map((item) => ({ kind: "item", item }));
    for (const s of Array.from(sections.values()).sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ kind: "heading", label: s.name });
      for (const item of s.items) rows.push({ kind: "item", item });
    }
    return rows;
  }, [invoice, invCategoryById]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !invoice) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Invoice not found.</p>
        <Button variant="secondary" href="/invoices">
          Back to Invoices
        </Button>
      </div>
    );
  }

  const total = Number(invoice.total);
  const payments: InvoicePayment[] = invoice.payments ?? [];
  // F03/R1: only CONFIRMED payments count toward the paid amount. VOID rows
  // (manually voided OR bounced checks — P5-12) don't, and neither do DRAFT
  // (unconfirmed) ones: the balance a bounce re-opens is the same balance an
  // unconfirmed row must never close. Prefer the server's own paidAmount /
  // balanceDue (invoices.service findOne, CONFIRMED_PAYMENT basis) so this page
  // agrees to the cent with the invoices list, the PDF and the emails; the
  // local sum is only a fallback for a payload that carries neither. The
  // `payments` array itself stays unfiltered — Payment History must keep
  // showing DRAFT rows so DraftPaymentBadge can mark them.
  // B421: confirmed but non-cash — a credit note or advance applied to this
  // invoice reduces balanceDue but must never render as "Paid"/cash received.
  // The shared helper's field is `totalPaid`; this DTO's is `paidAmount`.
  const {
    cash: amountPaid,
    creditApplied,
    advanceApplied,
  } = resolveConfirmedAmounts(
    {
      totalPaid: invoice.paidAmount,
      creditApplied: invoice.creditApplied,
      advanceApplied: invoice.advanceApplied,
    },
    payments,
  );
  const status = invoice.status;

  // Draft/Final invoice-PDF stage. Default: DRAFT while it's still the
  // pre-delivery proforma; FINAL once the order is delivered or the invoice is
  // issued. The operator can flip it and print/download/email either version
  // at any time (`pdfVariantOverride`).
  const defaultPdfVariant: InvoicePdfVariant = deriveInvoiceVariant(invoice);
  const pdfVariant: InvoicePdfVariant = pdfVariantOverride ?? defaultPdfVariant;
  const balanceDue =
    invoice.balanceDue != null
      ? Number(invoice.balanceDue)
      : status === "VOID" || status === "WRITTEN_OFF"
        ? 0
        : Math.max(0, total - amountPaid - creditApplied - advanceApplied);
  const discount = Number(invoice.discount ?? 0);
  const shippingFee = Number(invoice.shippingFee ?? 0);

  // The order-linked DRAFT that mirrors an un-delivered order: it auto-syncs to
  // the order and can't be edited or sent until the order is delivered. Edit the
  // order, not the invoice.
  const isPendingMirror =
    !!invoice.orderId &&
    status === "DRAFT" &&
    !invoice.deliveryBatchId &&
    !!invoice.order &&
    invoice.order.status !== "DELIVERED" &&
    invoice.order.status !== "PARTIALLY_DELIVERED";

  const canRecordPayment =
    status === "SENT" || status === "VIEWED" || status === "PARTIAL" || status === "OVERDUE";
  const canWriteOff =
    status === "SENT" || status === "VIEWED" || status === "PARTIAL" || status === "OVERDUE";
  const canVoid = status !== "PAID" && status !== "VOID" && status !== "WRITTEN_OFF";

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleSend = () => {
    // An import sentinel (`…@imported.local` / `…@placeholder.local`) is not a real
    // inbox — treat it as "no email on file" so the operator gets the Mark-as-Sent
    // path instead of a send that can only fail.
    const rawEmail = invoice.customer?.email;
    const customerEmail = rawEmail && !isInternalEmail(rawEmail) ? rawEmail : undefined;
    if (!customerEmail) {
      setSendBlocked({ kind: "no-email" });
      return;
    }
    sendInvoiceEmail.mutate(
      { id: invoice.id, email: customerEmail, variant: pdfVariant },
      {
        onSuccess: (res) => {
          // Resend rescued a tenant-SMTP failure — this is still a success (the
          // invoice went out), but the operator needs to know their OWN mail is
          // broken and that the From address silently changed. Distinct from the
          // plain success toast, and never buried as a footnote.
          if (res.warning) {
            toast({
              title: `${pdfVariant === "draft" ? "Draft" : "Final"} invoice emailed`,
              description: `Sent via RouteFlow's mail service${
                res.fromAddress ? ` (from ${res.fromAddress})` : ""
              } — your own email couldn't send: ${res.warning}.`,
              variant: "warning",
            });
            return;
          }
          toast({
            title: `${pdfVariant === "draft" ? "Draft" : "Final"} invoice emailed`,
            description: `Sent to ${res.sentTo}`,
            variant: "success",
          });
        },
        onError: (e: any) => {
          // R5: the API now refuses to claim "sent" when email isn't set up / the send
          // failed. On EMAIL_NOT_CONFIGURED, take the operator straight to Email settings.
          const code = e?.response?.data?.code;
          const description = e?.response?.data?.message || e.message;
          if (code === "EMAIL_NOT_CONFIGURED") {
            toast({
              title: "Email isn't set up yet",
              description: "Opening Email settings so you can configure it…",
              variant: "error",
            });
            router.push("/settings?tab=email");
            return;
          }
          if (code === "EMAIL_SEND_FAILED") {
            // The invoice is still DRAFT (R5 honesty). Offer Mark as Sent so a broken
            // mail transport can't leave the invoice stuck and payments locked.
            setSendBlocked({ kind: "send-failed", message: description });
            return;
          }
          toast({ title: "Failed to send email", description, variant: "error" });
        },
      },
    );
  };

  const handleMarkAsSent = () => {
    sendInvoice.mutate(invoice.id, {
      onSuccess: () => {
        setSendBlocked(null);
        toast({
          title: "Invoice marked as sent",
          description: "Status updated — no email was sent.",
          variant: "success",
        });
      },
      onError: (e) => toast({ title: "Failed", description: e.message, variant: "error" }),
    });
  };

  const handlePrint = () => {
    downloadPdf.mutate(
      { id: invoice.id, variant: pdfVariant },
      {
        onSuccess: ({ blob }) => printPdfBlob(blob),
        onError: () =>
          toast({
            title: "Failed to generate PDF",
            description: "Please try again.",
            variant: "error",
          }),
      },
    );
  };

  const handleReminder = () => {
    // Import sentinels count as "no email" — they aren't real inboxes.
    const rawReminderEmail = invoice.customer?.email;
    const customerEmail =
      rawReminderEmail && !isInternalEmail(rawReminderEmail) ? rawReminderEmail : undefined;
    if (!customerEmail) {
      toast({
        title: "No email on file",
        description: "Add an email address to this customer first.",
        variant: "error",
      });
      return;
    }
    sendInvoiceReminder.mutate(
      { id: invoice.id, email: customerEmail },
      {
        onSuccess: (res) => {
          // Same disclosure as the send path — a reminder rescued by Resend must
          // not stay silent about the operator's own mail being broken, or the
          // warning would depend on which button they happened to press.
          if (res.warning) {
            toast({
              title: "Reminder sent",
              description: `Sent via RouteFlow's mail service${
                res.fromAddress ? ` (from ${res.fromAddress})` : ""
              } — your own email couldn't send: ${res.warning}.`,
              variant: "warning",
            });
            return;
          }
          toast({
            title: "Reminder sent",
            description: `Reminder emailed to ${res.sentTo}`,
            variant: "success",
          });
        },
        onError: (e: any) =>
          toast({
            title: "Failed to send reminder",
            description: e?.response?.data?.message || e.message,
            variant: "error",
          }),
      },
    );
  };

  const handleVoid = () => {
    voidInvoice.mutate(invoice.id, {
      onSuccess: () => {
        setIsVoidOpen(false);
        toast({
          title: "Invoice voided",
          description: `Invoice ${invoice.invoiceNumber} has been voided.`,
          variant: "info",
        });
      },
      onError: (err: any) => {
        // The server explains exactly what's in the way (e.g. "$80.00 in
        // cash/check/card payments — reverse or refund those first"). Swallowing
        // it behind "Please try again" left the operator with no way forward.
        toast({
          title: "Couldn't void this invoice",
          description:
            err?.response?.data?.message ?? "Please try again, or check this invoice's payments.",
          variant: "error",
        });
      },
    });
  };

  const handleReopen = () => {
    reopenInvoice.mutate(invoice.id, {
      onSuccess: () => {
        setIsReopenOpen(false);
        toast({
          title: "Invoice reopened",
          description: `Invoice ${invoice.invoiceNumber} has been reopened.`,
          variant: "success",
        });
      },
      onError: () => {
        toast({
          title: "Failed to reopen invoice",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleWriteOff = (reason: string) => {
    writeOffInvoice.mutate(
      { id: invoice.id, reason },
      {
        onSuccess: () => {
          setIsWriteOffOpen(false);
          toast({
            title: "Invoice written off",
            description: `Invoice ${invoice.invoiceNumber} marked as written off.`,
            variant: "info",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to write off invoice",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleRecordPayment = (data: PaymentFormState, file: File | null) => {
    recordPayment.mutate(
      {
        id: invoice.id,
        method: data.method,
        amount: parseFloat(data.amount),
        paidAt: data.paidAt || undefined,
        settledAt: data.settledAt || undefined,
        reference: data.reference.trim() || undefined,
        notes: data.notes.trim() || undefined,
      },
      {
        onSuccess: (updated) => {
          setIsPaymentOpen(false);
          toast({
            title: "Payment recorded",
            description: `Payment of ${fmt(parseFloat(data.amount))} recorded.`,
            variant: "success",
          });
          // Best-effort: the payment is already recorded — an image-upload
          // failure must never look like the payment itself failed.
          if (file && updated.createdPaymentId) {
            uploadPaymentImage.mutate(
              { paymentId: updated.createdPaymentId, file },
              {
                onError: () => {
                  toast({
                    title: "Payment saved, image upload failed",
                    description: "You can attach it later from Payment History.",
                    variant: "error",
                  });
                },
              },
            );
          }
        },
        onError: (err: any) => {
          toast({
            title: "Failed to record payment",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleViewPaymentImage = (paymentId: string) => {
    getPaymentImageUrl.mutate(paymentId, {
      onSuccess: (res) => window.open(res.url, "_blank", "noopener,noreferrer"),
      onError: () => toast({ title: "Failed to load image", variant: "error" }),
    });
  };

  const handleSavePayment = (data: PaymentFormState) => {
    if (!editingPayment) return;
    updatePayment.mutate(
      {
        invoiceId: invoice.id,
        paymentId: editingPayment.id,
        method: data.method,
        amount: parseFloat(data.amount),
        paidAt: data.paidAt || undefined,
        // Explicit null so emptying the field clears the stored bank date.
        settledAt: data.settledAt || null,
        reference: data.reference.trim() || undefined,
        notes: data.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setEditingPayment(null);
          toast({ title: "Payment updated", variant: "success" });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to update payment",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleDeletePayment = () => {
    if (!deletingPayment) return;
    deletePayment.mutate(
      { invoiceId: invoice.id, paymentId: deletingPayment.id },
      {
        onSuccess: () => {
          setDeletingPayment(null);
          toast({ title: "Payment deleted", variant: "info" });
        },
        onError: () => {
          toast({ title: "Failed to delete payment", variant: "error" });
        },
      },
    );
  };

  const handleSetCheckStatus = (paymentId: string, checkStatus: CheckStatus, nsfFeeAmount = 0) => {
    setCheckStatus.mutate(
      { invoiceId: invoice.id, paymentId, status: checkStatus, nsfFeeAmount },
      {
        onSuccess: () => {
          if (checkStatus === "BOUNCED") setBouncingPayment(null);
          toast({
            title:
              checkStatus === "BOUNCED"
                ? "Check marked as bounced"
                : `Check marked as ${checkStatus.toLowerCase()}`,
            variant: checkStatus === "BOUNCED" ? "info" : "success",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to update check status",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleRemoveCredit = () => {
    if (!removingCreditPayment) return;
    const cnInfo = creditNoteOf(removingCreditPayment);
    if (!cnInfo) {
      setRemovingCreditPayment(null);
      return;
    }
    unapplyCreditNote.mutate(
      { id: cnInfo.id, invoiceId: invoice.id },
      {
        onSuccess: () => {
          setRemovingCreditPayment(null);
          toast({
            title: "Credit removed",
            description: "The credit note's balance has been restored.",
            variant: "success",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to remove credit",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleDuplicate = () => {
    const dto = {
      customerId: invoice.customerId,
      dueDate: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 30);
        return d.toISOString().slice(0, 10);
      })(),
      items: (invoice.items ?? []).map((it) => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
      })),
      notes: invoice.notes,
      referenceNumber: invoice.referenceNumber,
      subject: invoice.subject,
    };
    createInvoice.mutate(dto, {
      onSuccess: (newInv) => {
        toast({
          title: "Invoice duplicated",
          description: `New invoice ${newInv.invoiceNumber} created as a draft.`,
          variant: "success",
        });
        router.push(`/invoices/${newInv.id}`);
      },
      onError: () => {
        toast({ title: "Failed to duplicate invoice", variant: "error" });
      },
    });
  };

  const handleUpdateTerms = (fields: EditTermsFields) => {
    updateTerms.mutate(
      { id: invoice.id, ...fields },
      {
        onSuccess: () => {
          toast({ title: "Terms updated", variant: "success" });
          setIsEditTermsOpen(false);
        },
        onError: (err: any) => {
          toast({
            title: "Failed to update terms",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleDownloadPdf = () => {
    downloadPdf.mutate(
      { id: invoice.id, variant: pdfVariant },
      {
        onSuccess: ({ blob }) => {
          // Trigger the download via a same-origin blob URL — `window.open(url)`
          // can't be used here because the storage endpoint requires a JWT and a
          // top-level navigation has no token in localStorage scope.
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = `${invoice.invoiceNumber || invoice.id}-${pdfVariant}.pdf`;
          a.rel = "noopener noreferrer";
          document.body.appendChild(a);
          a.click();
          a.remove();
          // Revoke after the browser has had a chance to start the download.
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        },
        onError: () => {
          toast({
            title: "Failed to generate PDF",
            description: "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  // PR-2 (check-payments B1 hardening): mirrors the server guard's capacity
  // check (invoices.service updatePayment), which moved from summing only
  // CONFIRMED siblings to remainingCapacity() over every non-VOID sibling — a
  // DRAFT sibling now reserves capacity on both sides, so the modal still
  // refuses exactly what the API would refuse.
  const editPaymentMax = editingPayment
    ? remainingCapacity(
        total,
        payments.filter((p) => p.id !== editingPayment.id),
      )
    : 0;

  return (
    <div className="space-y-4 p-6">
      {/* Back */}
      <Link
        href="/invoices"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Invoices
      </Link>

      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-mono text-xl font-semibold tracking-tight text-navy">
              {invoice.invoiceNumber}
            </h1>
            <Badge status={status} />
          </div>
          <p className="mt-1 text-sm text-navy/70">
            {invoice.customer?.businessName ?? "—"}
            {(invoice as any).orderNumber ? ` · from ${(invoice as any).orderNumber}` : ""} · issued{" "}
            {fmtCalendarDate(invoice.issueDate ?? invoice.createdAt)}
            {invoice.dueDate ? ` · due ${fmtCalendarDate(invoice.dueDate)}` : ""}
          </p>
        </div>

        {/* Zoho-style action toolbar */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Pending mirror: this draft tracks an un-delivered order. Edit/Send are
              hidden until the order is delivered — edit the order, not the invoice. */}
          {isPendingMirror && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700">
              <Info className="h-3.5 w-3.5" />
              Mirrors the order — ready to send after delivery
            </span>
          )}

          {/* Edit — only for a draft that isn't a pending mirror */}
          {status === "DRAFT" && !isPendingMirror && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Pencil className="h-3.5 w-3.5" />}
              href={`/invoices/${invoice.id}/edit`}
            >
              Edit
            </Button>
          )}

          {/* Send (DRAFT) / Send Reminder (SENT/VIEWED/OVERDUE) */}
          {status === "DRAFT" && !isPendingMirror && (
            <Button
              size="sm"
              variant="primary"
              leftIcon={<Send className="h-3.5 w-3.5" />}
              onClick={handleSend}
              loading={sendInvoiceEmail.isPending || sendInvoice.isPending}
            >
              Send
            </Button>
          )}
          {(status === "SENT" || status === "VIEWED" || status === "OVERDUE") && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Send className="h-3.5 w-3.5" />}
              onClick={handleReminder}
              loading={sendInvoiceReminder.isPending}
            >
              Send Reminder
            </Button>
          )}

          {/* Draft/Final version toggle — controls which stage the printed,
              downloaded, or emailed PDF renders as (both available anytime). */}
          <div
            className="inline-flex items-center rounded-lg border border-surface-border p-0.5"
            role="group"
            aria-label="Invoice PDF version"
          >
            {(["draft", "final"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setPdfVariant(v)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                  pdfVariant === v
                    ? "bg-brand-500 text-white"
                    : "text-navy/70 hover:bg-surface-raised",
                )}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Print — always available */}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Printer className="h-3.5 w-3.5" />}
            onClick={handlePrint}
            loading={downloadPdf.isPending}
          >
            Print
          </Button>

          {/* PDF Download — always available */}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Download className="h-3.5 w-3.5" />}
            onClick={handleDownloadPdf}
            loading={downloadPdf.isPending}
          >
            PDF
          </Button>

          {/* Revert to Draft — SENT/VIEWED/OVERDUE with no payment ROWS at all:
              revertInvoiceToDraft refuses on `invoicePayment.count > 0`, which
              counts DRAFT and VOID rows too. Gating on amountPaid (a CONFIRMED
              sum) would offer a button the server always rejects. */}
          {(status === "SENT" || status === "VIEWED" || status === "OVERDUE") &&
            payments.length === 0 && (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={() => setIsRevertToDraftOpen(true)}
                loading={revertToDraft.isPending}
              >
                Revert to Draft
              </Button>
            )}

          {/* Unvoid — VOID invoices */}
          {status === "VOID" && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RotateCcw className="h-4 w-4" />}
              onClick={() => setIsUnvoidOpen(true)}
              loading={unvoid.isPending}
            >
              Unvoid
            </Button>
          )}

          {/* Record Payment dropdown */}
          {canRecordPayment && (
            <DropdownMenu
              trigger={
                <button
                  data-testid="record-payment-trigger"
                  className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy shadow-card transition-colors hover:bg-surface-raised"
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  Record Payment
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              }
              items={[
                { label: "Record Payment", onClick: () => setIsPaymentOpen(true) },
                // B13: web had no way to apply a customer's advance-payment wallet balance —
                // only mobile could. Same gate as Record Payment; the server also refuses a
                // settled/dead/forgiven invoice (CREDIT_NOT_APPLICABLE) regardless.
                ...(invoice.customerId
                  ? [{ label: "Apply Advance", onClick: () => setIsAdvanceOpen(true) }]
                  : []),
                { label: "Write Off", onClick: () => setIsWriteOffOpen(true), danger: true },
              ]}
            />
          )}

          {/* Adjust Prices — operator-only. Match backend gate exactly:
              PAID/VOID/WRITTEN_OFF reject with "Cannot adjust prices on a
              ${status} invoice. Issue a credit note instead." Hiding the
              button avoids the dead-click + invisible-toast UX where the
              panel opens, the user clicks Apply, and the success/error
              toast gets covered by the install prompt or other corner UI. */}
          {status !== "VOID" &&
            status !== "WRITTEN_OFF" &&
            status !== "PAID" &&
            !isPendingMirror && (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}
                onClick={() => setShowAdjustPanel((v) => !v)}
              >
                Adjust Prices
              </Button>
            )}

          {/* More actions (...) */}
          <DropdownMenu
            trigger={
              <button className="flex items-center justify-center rounded-lg border border-surface-border bg-white p-1.5 shadow-card transition-colors hover:bg-surface-raised">
                <MoreHorizontal className="h-4 w-4 text-navy/70" />
              </button>
            }
            items={[
              { label: "Duplicate", onClick: handleDuplicate },
              {
                // WP3: narrow post-issue correction of dueDate/paymentTermsLabel/
                // reference/subject only — blocked exactly where the API blocks it.
                label: "Edit Terms",
                onClick: () => setIsEditTermsOpen(true),
                disabled: status === "VOID" || status === "WRITTEN_OFF",
              },
              {
                label: "Reopen Invoice",
                onClick: () => setIsReopenOpen(true),
                disabled: status !== "PAID",
              },
              {
                label: "Void Invoice",
                onClick: () => setIsVoidOpen(true),
                danger: true,
                disabled: !canVoid,
              },
            ]}
          />
        </div>
      </div>

      {/* Write-off reason banner */}
      {status === "WRITTEN_OFF" && invoice.writeOffReason && (
        <div className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-stone-500" />
          <div className="text-sm text-stone-700">
            <span className="font-medium">Written off {fmtDate(invoice.writtenOffAt)}:</span>{" "}
            {invoice.writeOffReason}
          </div>
        </div>
      )}

      {/* What's Next guidance banner */}
      <WhatsNextBanner status={status} onRecordPayment={() => setIsPaymentOpen(true)} />

      {/* Pending mirror: explain that the invoice tracks the order until delivery. */}
      {isPendingMirror && (
        <div className="flex items-start gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
          <div className="text-sm text-navy/80">
            This invoice mirrors{" "}
            <Link
              href={`/orders/${invoice.orderId}`}
              className="font-semibold text-brand-700 hover:underline"
            >
              order #{invoice.order?.orderNumber ?? ""}
            </Link>{" "}
            and updates automatically until it&apos;s delivered. To change what&apos;s billed, edit
            the order — you&apos;ll review and send this invoice after delivery.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Invoice document (2/3) ── */}
        <div className="lg:col-span-2">
          <div className="relative overflow-hidden rounded-lg border border-surface-border bg-white p-8 shadow-card">
            {/* Status ribbon */}
            <StatusRibbon status={status} />

            {/* Invoice letterhead */}
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <p className="font-display text-2xl text-navy">Invoice</p>
                <p className="mt-1 font-mono text-xs text-navy/70">
                  {invoice.invoiceNumber} ·{" "}
                  {fmtCalendarDate(invoice.issueDate ?? invoice.createdAt)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <TenantLogo
                  className="h-8 w-8"
                  showName
                  nameClassName="text-base font-semibold text-navy"
                />
                {balanceDue > 0 && (
                  <div className="text-right">
                    <p className="overline">Balance Due</p>
                    <p className="money text-2xl font-semibold text-danger">{fmt(balanceDue)}</p>
                  </div>
                )}
                {balanceDue === 0 && status === "PAID" && (
                  <p className="text-lg font-semibold text-success">Paid in Full</p>
                )}
              </div>
            </div>

            {/* Billing + dates */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="overline mb-1.5">Bill To</p>
                <p className="text-sm font-semibold text-navy">
                  {invoice.customer?.businessName ?? "—"}
                </p>
                {invoice.customer?.contactName && (
                  <p className="text-sm text-navy/70">{invoice.customer.contactName}</p>
                )}
                {invoice.customer?.address && (
                  <p className="mt-1 text-xs text-navy/70 whitespace-pre-line">
                    {invoice.customer.address}
                  </p>
                )}
              </div>
              <div className="text-right space-y-1">
                <p className="overline mb-1.5">Invoice Details</p>
                <p className="text-sm text-navy/70">
                  <span className="font-medium text-navy">Issue Date:</span>{" "}
                  {fmtCalendarDate(invoice.issueDate ?? invoice.createdAt)}
                </p>
                {invoice.dueDate && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Due Date:</span>{" "}
                    <span className={cn(status === "OVERDUE" && "font-medium text-danger")}>
                      {fmtCalendarDate(invoice.dueDate)}
                    </span>
                  </p>
                )}
                {/* Structured "Net 30"-style label — distinct from the long-form
                    Terms & Conditions text below, which keeps its own line. */}
                {invoice.paymentTermsLabel && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Terms:</span>{" "}
                    {invoice.paymentTermsLabel}
                  </p>
                )}
                {invoice.depositOverdue && (
                  <p>
                    <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
                      Deposit overdue
                    </span>
                  </p>
                )}
                {(invoice as any).terms && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Terms &amp; Conditions:</span>{" "}
                    {(invoice as any).terms}
                  </p>
                )}
                {(invoice as any).orderNumber && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Reference:</span>{" "}
                    {(invoice as any).orderNumber}
                  </p>
                )}
              </div>
            </div>

            {/* Line items table — Ledger surface header */}
            <div className="-mx-8 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-surface-border bg-surface-raised">
                  <tr>
                    <th className="overline px-8 py-2.5 text-left">Item</th>
                    <th className="overline px-4 py-2.5 text-right">Qty</th>
                    <th className="overline px-4 py-2.5 text-right">Unit Price</th>
                    <th className="overline px-8 py-2.5 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {sectionedRows.map((row) => {
                    if (row.kind === "heading") {
                      return (
                        <tr key={`section-${row.label}`} className="bg-amber-50/40">
                          <td
                            colSpan={4}
                            className="px-8 py-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700"
                          >
                            {row.label} · regulated
                          </td>
                        </tr>
                      );
                    }
                    const item = row.item;
                    return (
                      <tr key={item.id} className="hover:bg-surface-raised">
                        <td className="px-8 py-3 font-medium text-navy">
                          {item.description}
                          {item.notes && (
                            <p className="mt-0.5 text-xs font-normal italic text-navy/60">
                              {item.notes}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className="mono text-navy/70"
                            title={
                              item.boxes != null || item.pieces != null
                                ? `${Number(item.qty)} pcs total`
                                : undefined
                            }
                          >
                            {formatQtySplit({
                              qty: item.qty,
                              boxes: item.boxes,
                              pieces: item.pieces,
                            })}
                          </span>
                          {/* BUY_N_GET_M: name the free units, or the reduced
                              subtotal reads as a pricing error. */}
                          {Number(item.promoFreeUnits ?? 0) > 0 && (
                            <p className="mt-0.5 text-[10px] font-medium text-amber-700">
                              {Number(item.promoFreeUnits)} free
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {item.priceType === "SPECIAL" && !hideOriginal ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="strike text-xs">
                                {fmt(Number(item.originalPrice))}
                              </span>
                              <span className="money text-success">
                                {fmt(Number(item.unitPrice))}
                              </span>
                              <span className="rounded-full bg-success-bg px-1.5 py-0.5 text-[10px] font-medium text-success ring-1 ring-success/20">
                                Special price
                              </span>
                            </div>
                          ) : item.priceType === "DISCOUNTED" && !hideOriginal ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="strike text-xs">
                                {fmt(Number(item.originalPrice))}
                              </span>
                              <span className="money text-warning">
                                {fmt(Number(item.unitPrice))}
                              </span>
                              <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning ring-1 ring-warning/20">
                                Discounted price
                              </span>
                            </div>
                          ) : item.priceType === "PROMO" &&
                            item.originalPrice != null &&
                            !hideOriginal ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="strike text-xs">
                                {fmt(Number(item.originalPrice))}
                              </span>
                              <span className="money text-brand-600">
                                {fmt(Number(item.unitPrice))}
                              </span>
                              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 ring-1 ring-brand-200">
                                Promo price
                              </span>
                            </div>
                          ) : item.priceType === "MANUAL" &&
                            item.originalPrice != null &&
                            Number(item.unitPrice) > Number(item.originalPrice) ? (
                            <div className="flex flex-col items-end gap-0.5">
                              {/* Upsell (above list): green, no strikethrough — the base
                                is never shown to the buyer. */}
                              <span className="money text-success">
                                {fmt(Number(item.unitPrice))}
                              </span>
                              <span className="rounded-full bg-success-bg px-1.5 py-0.5 text-[10px] font-medium text-success ring-1 ring-success/20">
                                Upsell
                              </span>
                            </div>
                          ) : item.priceType === "MANUAL" &&
                            item.originalPrice != null &&
                            !hideOriginal ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="strike text-xs">
                                {fmt(Number(item.originalPrice))}
                              </span>
                              <span className="money text-warning">
                                {fmt(Number(item.unitPrice))}
                              </span>
                              <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning ring-1 ring-warning/20">
                                Adjusted
                              </span>
                            </div>
                          ) : (
                            <span className="money text-navy/70">
                              {fmt(Number(item.unitPrice))}
                            </span>
                          )}
                          {/* Suggested retail price, snapshotted at line creation — appears
                              regardless of priceType. Keyed off data presence, not the flag,
                              so an issued invoice keeps rendering it even if the tenant later
                              loses the MSRP addon. */}
                          {item.msrp != null && (
                            <p className="mt-0.5 text-[10px] text-navy/50">
                              MSRP {fmt(Number(item.msrp))}/pc
                            </p>
                          )}
                        </td>
                        <td className="px-8 py-3 text-right">
                          <span className="money text-navy">
                            {/* Stored line subtotal is authoritative (boxed-aware, post-discount,
                              rounded via pricing.ts). NEVER re-derive qty*unitPrice — that
                              over-charges boxed lines by unitsPerBox and ignores line discounts. */}
                            {fmt(
                              Number(item.subtotal ?? Number(item.qty) * Number(item.unitPrice)),
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Totals footer */}
            <div className="mt-4 flex justify-end">
              <InvoiceTotalsSummary
                subtotal={Number(invoice.subtotal)}
                discount={discount}
                taxAmount={Number(invoice.taxAmount ?? 0)}
                shippingFee={shippingFee}
                amountPaid={amountPaid}
                creditApplied={creditApplied}
                advanceApplied={advanceApplied}
                balanceDue={balanceDue}
              />
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div className="mt-6 border-t border-surface-border pt-4">
                <p className="overline mb-1.5">Notes</p>
                <p className="text-sm text-navy/70 whitespace-pre-line">{invoice.notes}</p>
              </div>
            )}
          </div>

          {/* Adjust Prices Panel */}
          {showAdjustPanel && (
            <AdjustPricesPanel invoice={invoice} onClose={() => setShowAdjustPanel(false)} />
          )}
        </div>

        {/* ── Sidebar (1/3) ── */}
        <div className="space-y-4">
          {/* Linked order */}
          {(invoice as any).orderId && (
            <Card title="Linked Order">
              <div className="flex items-center gap-3">
                <Package className="h-4 w-4 text-navy/70" />
                <button
                  type="button"
                  onClick={() => setOrderPreviewOpen(true)}
                  className="text-sm font-medium text-brand-500 hover:underline"
                >
                  Preview order
                </button>
                <Link
                  href={`/orders/${(invoice as any).orderId}`}
                  className="text-sm text-navy/60 hover:underline"
                >
                  Open →
                </Link>
              </div>
            </Card>
          )}

          {/* Carrier shipment — operator records carrier + tracking number; editable
              on any non-void invoice (read-only once void / written off). Gated so it
              doesn't render on every invoice. The invoice payload's `order` selection
              (invoices.service.ts findOne) does NOT carry fulfillPath — widening it is
              out of scope for this package — so unlike the order detail page this can't
              gate on fulfillPath === "SHIP". Order-linked invoices instead show the card
              only once tracking exists: it's recorded on the ORDER, which mirrors carrier/
              tracking onto every non-void invoice of that order (orders.service
              updateShipment). A standalone invoice has no order to record it on, so it
              always keeps the card — this is its only place to enter tracking. */}
          {(!invoice.orderId || invoice.shippingCarrier || invoice.shippingTrackingNumber) && (
            <ShipmentCard
              carrier={invoice.shippingCarrier}
              trackingNumber={invoice.shippingTrackingNumber}
              shippedAt={invoice.shippedAt}
              isSaving={updateShipment.isPending}
              readOnly={status === "VOID" || status === "WRITTEN_OFF"}
              onSave={(values) => updateShipment.mutateAsync({ id: invoice.id, ...values })}
            />
          )}

          {/* Payment history */}
          <Card title="Payment History">
            {payments.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-raised">
                  <CreditCard className="h-5 w-5 text-navy/30" />
                </div>
                <p className="font-display text-base text-navy">No payments yet</p>
                <p className="max-w-[240px] text-xs text-navy/70">
                  Record a payment to apply it against this balance.
                </p>
              </div>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {payments.map((pmt) => {
                  const isVoided = pmt.status === "VOID";
                  const isEditable =
                    pmt.method !== "CREDIT_NOTE" &&
                    pmt.method !== "ADVANCE" &&
                    !isVoided &&
                    status !== "VOID" &&
                    status !== "WRITTEN_OFF" &&
                    status !== "PAID";
                  const checkStatusForRow = effectiveCheckStatus(pmt);
                  // P5-12: available on any CHECK payment that isn't voided yet — a
                  // paid invoice can still have its check advanced/bounced.
                  const canSetCheckStatus = pmt.method === "CHECK" && !isVoided;
                  return (
                    <li key={pmt.id} className="group flex items-start gap-3 px-6 py-4">
                      <div
                        className={cn(
                          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                          isVoided ? "bg-navy/5" : "bg-success-bg",
                        )}
                      >
                        {isVoided ? (
                          <XCircle className="h-4 w-4 text-navy/30" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "money text-sm font-semibold",
                              isVoided ? "text-navy/40 line-through" : "text-navy",
                            )}
                          >
                            {fmt(Number(pmt.amount))}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-navy/70">
                              {fmtDate(pmt.paidAt ?? pmt.createdAt)}
                              {pmt.settledAt && (
                                <span className="text-navy/40">
                                  {" "}
                                  · landed {fmtDate(pmt.settledAt)}
                                </span>
                              )}
                            </span>
                            {isEditable && (
                              <>
                                <button
                                  onClick={() => setEditingPayment(pmt)}
                                  className="rounded p-1 text-navy/30 opacity-0 group-hover:opacity-100 hover:text-brand-500 transition-all"
                                  title="Edit payment"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => setDeletingPayment(pmt)}
                                  className="rounded p-1 text-navy/30 opacity-0 group-hover:opacity-100 hover:text-danger transition-all"
                                  title="Delete payment"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                              methodBadgeClass(pmt.method),
                            )}
                          >
                            {methodLabel(pmt.method)}
                          </span>
                          {pmt.status === "DRAFT" && <DraftPaymentBadge />}
                          {checkStatusForRow && <CheckStatusBadge status={checkStatusForRow} />}
                          {pmt.reference && (
                            <span className="text-xs text-navy/70">· {pmt.reference}</span>
                          )}
                        </div>
                        {pmt.notes && <p className="mt-0.5 text-xs text-navy/70">{pmt.notes}</p>}
                        {pmt.imageKey && (
                          <button
                            type="button"
                            onClick={() => handleViewPaymentImage(pmt.id)}
                            className="mt-1 flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                          >
                            <Paperclip className="h-3 w-3" />
                            View receipt
                          </button>
                        )}
                        {pmt.method === "CREDIT_NOTE" &&
                          (() => {
                            const cnInfo = creditNoteOf(pmt);
                            if (!cnInfo) return null;
                            return (
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-navy/70">
                                <Link
                                  href={`/credit-notes/${cnInfo.id}`}
                                  className="font-mono text-brand-600 hover:underline"
                                >
                                  {cnInfo.creditNoteNumber}
                                </Link>
                                {cnInfo.reason && <span>— {cnInfo.reason}</span>}
                                {isOperator && !isVoided && (
                                  <button
                                    type="button"
                                    onClick={() => setRemovingCreditPayment(pmt)}
                                    className="font-medium text-danger hover:underline"
                                  >
                                    Remove credit
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        {canSetCheckStatus && (
                          <div className="mt-1.5">
                            <DropdownMenu
                              trigger={
                                <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy">
                                  Check
                                  <ChevronDown className="h-3 w-3" />
                                </button>
                              }
                              items={[
                                {
                                  label: "Mark deposited",
                                  onClick: () => handleSetCheckStatus(pmt.id, "DEPOSITED"),
                                  disabled:
                                    !CHECK_TRANSITIONS[checkStatusForRow ?? "RECORDED"].includes(
                                      "DEPOSITED",
                                    ),
                                },
                                {
                                  label: "Mark cleared",
                                  onClick: () => handleSetCheckStatus(pmt.id, "CLEARED"),
                                  disabled:
                                    !CHECK_TRANSITIONS[checkStatusForRow ?? "RECORDED"].includes(
                                      "CLEARED",
                                    ),
                                },
                                {
                                  label: "Mark bounced…",
                                  onClick: () => setBouncingPayment(pmt),
                                  danger: true,
                                  disabled:
                                    !CHECK_TRANSITIONS[checkStatusForRow ?? "RECORDED"].includes(
                                      "BOUNCED",
                                    ),
                                },
                              ]}
                            />
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {canRecordPayment && (
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  leftIcon={<CreditCard className="h-4 w-4" />}
                  onClick={() => setIsPaymentOpen(true)}
                >
                  Record Payment
                </Button>
              </div>
            )}
          </Card>

          {/* Balance summary */}
          <Card>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-navy/70">Invoice Total</dt>
                <dd className="money font-medium text-navy">{fmt(total)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-navy/70">Payments received</dt>
                <dd className="money font-medium text-success">{fmt(amountPaid)}</dd>
              </div>
              {/* B421: neutral styling — never text-success — a credit note or
                  advance reduces the balance but isn't cash received. */}
              {creditApplied > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-navy/70">Credits applied</dt>
                  <dd className="money font-medium text-navy">{fmt(creditApplied)}</dd>
                </div>
              )}
              {advanceApplied > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-navy/70">Advance applied</dt>
                  <dd className="money font-medium text-navy">{fmt(advanceApplied)}</dd>
                </div>
              )}
              <div
                className={cn(
                  "flex items-center justify-between border-t border-surface-border pt-2 font-semibold",
                  balanceDue > 0 ? "text-danger" : "text-success",
                )}
              >
                <dt>Balance Due</dt>
                <dd className="money">{fmt(balanceDue)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      {/* Modals */}
      <RecordPaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        onRecord={handleRecordPayment}
        balanceDue={balanceDue}
        isPending={recordPayment.isPending}
      />

      {isAdvanceOpen && invoice.customerId && (
        <ApplyAdvanceModal
          isOpen={isAdvanceOpen}
          onClose={() => setIsAdvanceOpen(false)}
          customerId={invoice.customerId}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoiceNumber}
        />
      )}

      <EditPaymentModal
        isOpen={!!editingPayment}
        onClose={() => setEditingPayment(null)}
        onSave={handleSavePayment}
        payment={editingPayment}
        maxAmount={editPaymentMax}
        isPending={updatePayment.isPending}
      />

      <DeletePaymentModal
        isOpen={!!deletingPayment}
        onClose={() => setDeletingPayment(null)}
        onConfirm={handleDeletePayment}
        amount={Number(deletingPayment?.amount ?? 0)}
        isPending={deletePayment.isPending}
      />

      <MarkBouncedModal
        isOpen={!!bouncingPayment}
        onClose={() => setBouncingPayment(null)}
        onConfirm={(nsfFeeAmount) => {
          if (!bouncingPayment) return;
          handleSetCheckStatus(bouncingPayment.id, "BOUNCED", nsfFeeAmount);
        }}
        amount={Number(bouncingPayment?.amount ?? 0)}
        isPending={setCheckStatus.isPending}
      />

      <ConfirmDialog
        open={!!removingCreditPayment}
        onClose={() => setRemovingCreditPayment(null)}
        onConfirm={handleRemoveCredit}
        title="Remove this credit?"
        description={`This will un-apply ${fmt(Number(removingCreditPayment?.amount ?? 0))} from this invoice and restore it to the credit note's balance.`}
        confirmLabel="Remove credit"
        loading={unapplyCreditNote.isPending}
      />

      <VoidConfirmModal
        isOpen={isVoidOpen}
        onClose={() => setIsVoidOpen(false)}
        onConfirm={handleVoid}
        invoiceNumber={invoice.invoiceNumber}
        isPending={voidInvoice.isPending}
      />

      <Modal
        open={isReopenOpen}
        onClose={() => setIsReopenOpen(false)}
        title="Reopen Invoice?"
        description={`Invoice ${invoice.invoiceNumber} will be moved back to the appropriate open state.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsReopenOpen(false)}
              disabled={reopenInvoice.isPending}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={handleReopen} loading={reopenInvoice.isPending}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Reopen Invoice
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Are you sure you want to reopen this invoice? This will change its status back to the
          appropriate state.
        </p>
      </Modal>

      <WriteOffModal
        isOpen={isWriteOffOpen}
        onClose={() => setIsWriteOffOpen(false)}
        onConfirm={handleWriteOff}
        invoiceNumber={invoice.invoiceNumber}
        isPending={writeOffInvoice.isPending}
      />

      <EditTermsModal
        isOpen={isEditTermsOpen}
        onClose={() => setIsEditTermsOpen(false)}
        onConfirm={handleUpdateTerms}
        invoice={invoice}
        isPending={updateTerms.isPending}
      />

      <Modal
        open={isRevertToDraftOpen}
        onClose={() => setIsRevertToDraftOpen(false)}
        title="Revert to Draft?"
        description={`Invoice ${invoice.invoiceNumber} will be moved back to Draft status.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsRevertToDraftOpen(false)}
              disabled={revertToDraft.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                revertToDraft.mutate(invoice.id, {
                  onSuccess: () => {
                    setIsRevertToDraftOpen(false);
                    toast({ title: "Invoice reverted to Draft", variant: "success" });
                  },
                  onError: (e: any) =>
                    toast({
                      title: "Failed to revert",
                      description: e?.response?.data?.message ?? "Please try again.",
                      variant: "error",
                    }),
                });
              }}
              loading={revertToDraft.isPending}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Revert to Draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          This will undeliver the invoice from the customer. No payments have been recorded, so this
          is safe to revert.
        </p>
      </Modal>

      <Modal
        open={isUnvoidOpen}
        onClose={() => setIsUnvoidOpen(false)}
        title="Unvoid Invoice?"
        description={`Invoice ${invoice.invoiceNumber} will be moved back to Draft status.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsUnvoidOpen(false)}
              disabled={unvoid.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                unvoid.mutate(invoice.id, {
                  onSuccess: () => {
                    setIsUnvoidOpen(false);
                    toast({ title: "Invoice unvoided — now in Draft", variant: "success" });
                  },
                  onError: (e: any) =>
                    toast({
                      title: "Failed to unvoid",
                      description: e?.response?.data?.message ?? "Please try again.",
                      variant: "error",
                    }),
                });
              }}
              loading={unvoid.isPending}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Unvoid
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Are you sure you want to unvoid this invoice? It will return to Draft status and can be
          edited and re-sent.
        </p>
      </Modal>

      <NoEmailModal
        reason={sendBlocked}
        onClose={() => setSendBlocked(null)}
        customerName={invoice.customer?.businessName ?? "This customer"}
        onMarkSent={handleMarkAsSent}
        onDownload={() => {
          handleDownloadPdf();
          setSendBlocked(null);
        }}
        onPrint={() => {
          handlePrint();
          setSendBlocked(null);
        }}
        isPending={sendInvoice.isPending}
      />

      {(invoice as any).orderId && (
        <OrderPreviewModal
          open={orderPreviewOpen}
          onClose={() => setOrderPreviewOpen(false)}
          orderId={(invoice as any).orderId}
        />
      )}
    </div>
  );
}
