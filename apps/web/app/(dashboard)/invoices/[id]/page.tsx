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
  useDownloadInvoicePdf,
  type InvoicePdfVariant,
  useRevertInvoiceToDraft,
  useUnvoidInvoice,
  useAdjustInvoicePrices,
  useUpdateInvoiceShipment,
  type Invoice,
  type InvoiceStatus,
  type InvoicePayment,
} from "@/lib/api/invoices";
import { useRouter } from "next/navigation";
import { fmt, fmtDate } from "@/lib/formatting";
import { formatQtySplit } from "@/lib/pricing";
import { TenantLogo } from "@/components/TenantLogo";
import { ShipmentCard } from "@/components/ShipmentCard";
import { useTenant } from "@/components/tenant-provider";
import { OrderPreviewModal } from "../../_components/LinkedDocPreviewModal";

function methodLabel(method: string) {
  switch (method) {
    case "CASH":
      return "Cash";
    case "CHECK":
      return "Check";
    case "ACH":
      return "ACH / Bank Transfer";
    case "CREDIT_NOTE":
      return "Credit Note";
    case "ADVANCE":
      return "Advance Payment";
    default:
      return method;
  }
}

function methodBadgeClass(method: string) {
  switch (method) {
    case "CREDIT_NOTE":
      return "bg-purple-100 text-purple-700";
    case "ADVANCE":
      return "bg-teal-100 text-teal-700";
    case "CASH":
      return "bg-green-100 text-green-700";
    case "CHECK":
      return "bg-blue-100 text-blue-700";
    case "ACH":
      return "bg-indigo-100 text-indigo-700";
    default:
      return "bg-gray-100 text-gray-600";
  }
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
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD";
  amount: string;
  reference: string;
  notes: string;
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
  onRecord: (data: PaymentFormState) => void;
  balanceDue: number;
  isPending: boolean;
}) {
  const [form, setForm] = React.useState<PaymentFormState>({
    method: "ACH",
    amount: "",
    reference: "",
    notes: "",
  });
  const [amountError, setAmountError] = React.useState("");

  React.useEffect(() => {
    if (isOpen) {
      setForm({
        method: "ACH",
        amount: balanceDue > 0 ? balanceDue.toFixed(2) : "",
        reference: "",
        notes: "",
      });
      setAmountError("");
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
    onRecord(form);
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
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="ACH">ACH / Bank Transfer</option>
            <option value="CREDIT_CARD">Credit Card</option>
            <option value="OTHER">Other</option>
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
      </form>
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
  const [form, setForm] = React.useState<PaymentFormState>({
    method: "ACH",
    amount: "",
    reference: "",
    notes: "",
  });
  const [amountError, setAmountError] = React.useState("");

  React.useEffect(() => {
    if (isOpen && payment) {
      setForm({
        method: payment.method as PaymentFormState["method"],
        amount: Number(payment.amount).toFixed(2),
        reference: payment.reference ?? "",
        notes: payment.notes ?? "",
      });
      setAmountError("");
    }
  }, [isOpen, payment]);

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
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="ACH">ACH / Bank Transfer</option>
            <option value="CREDIT_CARD">Credit Card</option>
            <option value="OTHER">Other</option>
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

// ─── No-email guard modal ─────────────────────────────────────────────────────

function NoEmailModal({
  isOpen,
  onClose,
  customerName,
  onMarkSent,
  onDownload,
  onPrint,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  customerName: string;
  onMarkSent: () => void;
  onDownload: () => void;
  onPrint: () => void;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="No email on file"
      description={`${customerName} has no email address saved. You can download or print the invoice to send it manually, or mark it as sent to update its status.`}
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
        Add an email address to this customer&apos;s profile to send invoices by email in the
        future.
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

export default function InvoiceDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: invoice, isLoading, isError } = useInvoice(params.id);
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
  const downloadPdf = useDownloadInvoicePdf();
  const revertToDraft = useRevertInvoiceToDraft();
  const unvoid = useUnvoidInvoice();
  const updateShipment = useUpdateInvoiceShipment();

  const [isPaymentOpen, setIsPaymentOpen] = React.useState(false);
  const [showAdjustPanel, setShowAdjustPanel] = React.useState(false);
  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isReopenOpen, setIsReopenOpen] = React.useState(false);
  const [isWriteOffOpen, setIsWriteOffOpen] = React.useState(false);
  const [isRevertToDraftOpen, setIsRevertToDraftOpen] = React.useState(false);
  const [isUnvoidOpen, setIsUnvoidOpen] = React.useState(false);
  const [isNoEmailOpen, setIsNoEmailOpen] = React.useState(false);
  const [editingPayment, setEditingPayment] = React.useState<InvoicePayment | null>(null);
  const [deletingPayment, setDeletingPayment] = React.useState<InvoicePayment | null>(null);
  // Explicit Draft/Final PDF-stage override; null = follow the smart default.
  const [pdfVariantOverride, setPdfVariant] = React.useState<InvoicePdfVariant | null>(null);
  // Floating "View order" preview popup.
  const [orderPreviewOpen, setOrderPreviewOpen] = React.useState(false);

  React.useEffect(() => {
    if (invoice) setTitle(invoice.invoiceNumber);
  }, [invoice, setTitle]);

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
  const amountPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const status = invoice.status;

  // Draft/Final invoice-PDF stage. Default: DRAFT while it's still the
  // pre-delivery proforma; FINAL once the order is delivered or the invoice is
  // issued. The operator can flip it and print/download/email either version
  // at any time (`pdfVariantOverride`).
  const defaultPdfVariant: InvoicePdfVariant =
    invoice.status !== "DRAFT" || invoice.order?.status === "DELIVERED" ? "final" : "draft";
  const pdfVariant: InvoicePdfVariant = pdfVariantOverride ?? defaultPdfVariant;
  const balanceDue =
    status === "VOID" || status === "WRITTEN_OFF" ? 0 : Math.max(0, total - amountPaid);
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
    const customerEmail = invoice.customer?.email;
    if (!customerEmail) {
      setIsNoEmailOpen(true);
      return;
    }
    sendInvoiceEmail.mutate(
      { id: invoice.id, email: customerEmail, variant: pdfVariant },
      {
        onSuccess: (res) =>
          toast({
            title: `${pdfVariant === "draft" ? "Draft" : "Final"} invoice emailed`,
            description: `Sent to ${res.sentTo}`,
            variant: "success",
          }),
        onError: (e: any) =>
          toast({
            title: "Failed to send email",
            description: e?.response?.data?.message || e.message,
            variant: "error",
          }),
      },
    );
  };

  const handleMarkAsSent = () => {
    sendInvoice.mutate(invoice.id, {
      onSuccess: () => {
        setIsNoEmailOpen(false);
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
        onSuccess: ({ blob }) => {
          const blobUrl = URL.createObjectURL(blob);
          const iframe = document.createElement("iframe");
          iframe.style.display = "none";
          iframe.src = blobUrl;
          document.body.appendChild(iframe);
          iframe.onload = () => {
            iframe.contentWindow?.print();
            setTimeout(() => {
              iframe.remove();
              URL.revokeObjectURL(blobUrl);
            }, 60_000);
          };
        },
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
    const customerEmail = invoice.customer?.email;
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
        onSuccess: (res) =>
          toast({
            title: "Reminder sent",
            description: `Reminder emailed to ${res.sentTo}`,
            variant: "success",
          }),
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
      onError: () => {
        toast({
          title: "Failed to void invoice",
          description: "Please try again.",
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

  const handleRecordPayment = (data: PaymentFormState) => {
    recordPayment.mutate(
      {
        id: invoice.id,
        method: data.method as "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD",
        amount: parseFloat(data.amount),
        reference: data.reference.trim() || undefined,
        notes: data.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setIsPaymentOpen(false);
          toast({
            title: "Payment recorded",
            description: `Payment of ${fmt(parseFloat(data.amount))} recorded.`,
            variant: "success",
          });
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

  const handleSavePayment = (data: PaymentFormState) => {
    if (!editingPayment) return;
    updatePayment.mutate(
      {
        invoiceId: invoice.id,
        paymentId: editingPayment.id,
        method: data.method as "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD",
        amount: parseFloat(data.amount),
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

  // For edit payment: max amount = total - (all other payments)
  const editPaymentMax = editingPayment
    ? total -
      payments.filter((p) => p.id !== editingPayment.id).reduce((s, p) => s + Number(p.amount), 0)
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
            {fmtDate(invoice.issueDate ?? invoice.createdAt)}
            {invoice.dueDate ? ` · due ${fmtDate(invoice.dueDate)}` : ""}
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

          {/* Revert to Draft — SENT/VIEWED/OVERDUE with no payments */}
          {(status === "SENT" || status === "VIEWED" || status === "OVERDUE") &&
            amountPaid === 0 && (
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
                <button className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy shadow-card transition-colors hover:bg-surface-raised">
                  <CreditCard className="h-3.5 w-3.5" />
                  Record Payment
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              }
              items={[
                { label: "Record Payment", onClick: () => setIsPaymentOpen(true) },
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
                  {invoice.invoiceNumber} · {fmtDate(invoice.issueDate ?? invoice.createdAt)}
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
                  {fmtDate(invoice.issueDate ?? invoice.createdAt)}
                </p>
                {invoice.dueDate && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Due Date:</span>{" "}
                    <span className={cn(status === "OVERDUE" && "font-medium text-danger")}>
                      {fmtDate(invoice.dueDate)}
                    </span>
                  </p>
                )}
                {(invoice as any).terms && (
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Terms:</span> {(invoice as any).terms}
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
                  {(invoice.items ?? []).map((item) => (
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
                      </td>
                      <td className="px-4 py-3 text-right">
                        {item.priceType === "SPECIAL" ? (
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
                        ) : item.priceType === "DISCOUNTED" ? (
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
                        ) : item.priceType === "PROMO" && item.originalPrice != null ? (
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
                        ) : item.priceType === "MANUAL" && item.originalPrice != null ? (
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
                          <span className="money text-navy/70">{fmt(Number(item.unitPrice))}</span>
                        )}
                      </td>
                      <td className="px-8 py-3 text-right">
                        <span className="money text-navy">
                          {/* Stored line subtotal is authoritative (boxed-aware, post-discount,
                              rounded via pricing.ts). NEVER re-derive qty*unitPrice — that
                              over-charges boxed lines by unitsPerBox and ignores line discounts. */}
                          {fmt(Number(item.subtotal ?? Number(item.qty) * Number(item.unitPrice)))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals footer */}
            <div className="mt-4 flex justify-end">
              <div className="w-72 space-y-1.5 text-sm">
                <div className="flex justify-between py-0.5">
                  <span className="text-navy/70">Subtotal</span>
                  <span className="money text-navy">{fmt(Number(invoice.subtotal))}</span>
                </div>
                {discount > 0 && (
                  <div className="flex justify-between py-0.5 text-success">
                    <span>Discount</span>
                    <span className="money">-{fmt(discount)}</span>
                  </div>
                )}
                {Number(invoice.taxAmount ?? 0) > 0 && (
                  <div className="flex justify-between py-0.5">
                    <span className="text-navy/70">Tax</span>
                    <span className="money text-navy">{fmt(Number(invoice.taxAmount))}</span>
                  </div>
                )}
                {shippingFee > 0 && (
                  <div className="flex justify-between py-0.5">
                    <span className="text-navy/70">Shipping</span>
                    <span className="money text-navy">{fmt(shippingFee)}</span>
                  </div>
                )}
                {amountPaid > 0 && (
                  <div className="flex justify-between py-0.5 text-success">
                    <span>Paid to date</span>
                    <span className="money">-{fmt(amountPaid)}</span>
                  </div>
                )}
                <div
                  className={cn(
                    "mt-1.5 flex items-center justify-between border-t border-navy pt-2.5 text-base font-semibold",
                    balanceDue > 0 ? "text-danger" : "text-success",
                  )}
                >
                  <span>Balance due</span>
                  <span className="money">{fmt(balanceDue)}</span>
                </div>
              </div>
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
              on any non-void invoice (read-only once void / written off). */}
          <ShipmentCard
            carrier={invoice.shippingCarrier}
            trackingNumber={invoice.shippingTrackingNumber}
            shippedAt={invoice.shippedAt}
            isSaving={updateShipment.isPending}
            readOnly={status === "VOID" || status === "WRITTEN_OFF"}
            onSave={(values) => updateShipment.mutateAsync({ id: invoice.id, ...values })}
          />

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
                  const isEditable =
                    pmt.method !== "CREDIT_NOTE" &&
                    pmt.method !== "ADVANCE" &&
                    status !== "VOID" &&
                    status !== "WRITTEN_OFF" &&
                    status !== "PAID";
                  return (
                    <li key={pmt.id} className="group flex items-start gap-3 px-6 py-4">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-bg">
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="money text-sm font-semibold text-navy">
                            {fmt(Number(pmt.amount))}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-navy/70">{fmtDate(pmt.createdAt)}</span>
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
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                              methodBadgeClass(pmt.method),
                            )}
                          >
                            {methodLabel(pmt.method)}
                          </span>
                          {pmt.reference && (
                            <span className="text-xs text-navy/70">· {pmt.reference}</span>
                          )}
                        </div>
                        {pmt.notes && <p className="mt-0.5 text-xs text-navy/70">{pmt.notes}</p>}
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
                <dt className="text-navy/70">Paid</dt>
                <dd className="money font-medium text-success">{fmt(amountPaid)}</dd>
              </div>
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
        isOpen={isNoEmailOpen}
        onClose={() => setIsNoEmailOpen(false)}
        customerName={invoice.customer?.businessName ?? "This customer"}
        onMarkSent={handleMarkAsSent}
        onDownload={() => {
          handleDownloadPdf();
          setIsNoEmailOpen(false);
        }}
        onPrint={() => {
          handlePrint();
          setIsNoEmailOpen(false);
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
