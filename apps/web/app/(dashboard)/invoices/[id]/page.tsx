"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Send,
  CreditCard,
  Download,
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
import { Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";
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
  useRevertInvoiceToDraft,
  useUnvoidInvoice,
  useAdjustInvoicePrices,
  type Invoice,
  type InvoiceStatus,
  type InvoicePayment,
} from "@/lib/api/invoices";
import { useRouter } from "next/navigation";
import { fmt, fmtDate } from "@/lib/formatting";

function methodLabel(method: string) {
  switch (method) {
    case "CASH": return "Cash";
    case "CHECK": return "Check";
    case "ACH": return "ACH / Bank Transfer";
    case "CREDIT_NOTE": return "Credit Note";
    case "ADVANCE": return "Advance Payment";
    default: return method;
  }
}

function methodBadgeClass(method: string) {
  switch (method) {
    case "CREDIT_NOTE": return "bg-purple-100 text-purple-700";
    case "ADVANCE": return "bg-teal-100 text-teal-700";
    case "CASH": return "bg-green-100 text-green-700";
    case "CHECK": return "bg-blue-100 text-blue-700";
    case "ACH": return "bg-indigo-100 text-indigo-700";
    default: return "bg-gray-100 text-gray-600";
  }
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  SENT: "bg-blue-100 text-blue-700",
  VIEWED: "bg-purple-100 text-purple-700",
  PARTIAL: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
  OVERDUE: "bg-red-100 text-red-600",
  WRITTEN_OFF: "bg-stone-100 text-stone-600",
};

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status],
      )}
    >
      {status === "WRITTEN_OFF"
        ? "Written Off"
        : status.charAt(0) + status.slice(1).toLowerCase()}
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
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_NOTE" | "ADVANCE" | "CREDIT_CARD";
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
      <form
        id="invoice-payment-form"
        onSubmit={handleSubmit}
        noValidate
        className="space-y-4"
      >
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Payment Method
          </label>
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
            <option value="CREDIT_NOTE">Credit Note</option>
            <option value="ADVANCE">Advance Payment</option>
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
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes (optional)
          </label>
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
            onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as PaymentFormState["method"] }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="ACH">ACH / Bank Transfer</option>
            <option value="CREDIT_CARD">Credit Card</option>
            <option value="CREDIT_NOTE">Credit Note</option>
            <option value="ADVANCE">Advance Payment</option>
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
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Reference # (optional)</label>
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
    if (isOpen) { setReason(""); setError(""); }
  }, [isOpen]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) { setError("Please provide a reason for writing off this invoice."); return; }
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
          <Button variant="secondary" onClick={onClose} disabled={isPending}>Cancel</Button>
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
            Writing off an invoice marks the remaining balance as uncollectible. This action cannot be undone.
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
          <Button variant="secondary" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} loading={isPending}>Delete Payment</Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        The invoice balance will be updated automatically. This action cannot be undone.
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
              onClick={() => { item.onClick(); setOpen(false); }}
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

function AdjustPricesPanel({
  invoice,
  onClose,
}: {
  invoice: Invoice;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const adjust = useAdjustInvoicePrices();

  const items = invoice.items ?? [];
  const [prices, setPrices] = React.useState<Record<string, string>>(
    () => Object.fromEntries(items.map((it) => [it.id, String(Number(it.unitPrice).toFixed(2))])),
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
        newUnitPrice: parseFloat(prices[it.id] ?? String(Number(it.unitPrice))) || Number(it.unitPrice),
      })),
      scope,
      ...(scope === "ALL_CUSTOMER_SINCE" ? { sinceDate } : {}),
    };
    adjust.mutate(dto, {
      onSuccess: () => {
        toast({ title: "Prices updated", description: scope === "SINGLE" ? "Invoice prices have been adjusted." : "Prices updated across matching invoices.", variant: "success" });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: "Failed to adjust prices", description: err?.response?.data?.message ?? "Please try again.", variant: "error" });
      },
    });
  }

  return (
    <Card title="Adjust Prices">
      <p className="mb-4 text-sm text-navy/60">
        Override unit prices on this invoice. Totals will be recalculated and an audit note appended.
      </p>

      {/* Per-item price inputs */}
      <div className="mb-5 divide-y divide-surface-border rounded-lg border border-surface-border">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-navy">{item.description}</p>
              <p className="text-xs text-navy/40">Qty: {item.qty} · Current: {fmt(Number(item.unitPrice))}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-navy/40">$</span>
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
        <p className="text-xs font-semibold uppercase tracking-wider text-navy/50">Scope</p>
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
            All invoices for <strong>{invoice.customer?.businessName ?? "this customer"}</strong> from:
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
            <p className="mt-1 text-xs text-navy/40">All matching invoices created on or after this date will be updated.</p>
          </div>
        )}
      </div>

      {scope === "ALL_CUSTOMER_SINCE" && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          Bulk update will modify all open invoices for this customer from the selected date. This cannot be undone.
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={adjust.isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} loading={adjust.isPending} leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}>
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

  const [isPaymentOpen, setIsPaymentOpen] = React.useState(false);
  const [showAdjustPanel, setShowAdjustPanel] = React.useState(false);
  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isReopenOpen, setIsReopenOpen] = React.useState(false);
  const [isWriteOffOpen, setIsWriteOffOpen] = React.useState(false);
  const [isRevertToDraftOpen, setIsRevertToDraftOpen] = React.useState(false);
  const [isUnvoidOpen, setIsUnvoidOpen] = React.useState(false);
  const [editingPayment, setEditingPayment] = React.useState<InvoicePayment | null>(null);
  const [deletingPayment, setDeletingPayment] = React.useState<InvoicePayment | null>(null);

  React.useEffect(() => {
    if (invoice) setTitle(invoice.invoiceNumber);
  }, [invoice, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
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
  const balanceDue = status === "VOID" || status === "WRITTEN_OFF" ? 0 : Math.max(0, total - amountPaid);
  const discount = Number(invoice.discount ?? 0);
  const shippingFee = Number(invoice.shippingFee ?? 0);

  const canRecordPayment = status === "SENT" || status === "VIEWED" || status === "PARTIAL" || status === "OVERDUE";
  const canWriteOff = status === "SENT" || status === "VIEWED" || status === "PARTIAL" || status === "OVERDUE";
  const canVoid = status !== "PAID" && status !== "VOID" && status !== "WRITTEN_OFF";
  const canDownloadPdf = status !== "DRAFT";

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleSend = () => {
    const customerEmail = invoice.customer?.email;
    if (!customerEmail) {
      // No email on file — just mark as sent without emailing
      sendInvoice.mutate(invoice.id, {
        onSuccess: () => toast({ title: "Invoice marked as sent", description: "No customer email on file — status updated only.", variant: "success" }),
        onError: (e) => toast({ title: "Failed", description: e.message, variant: "error" }),
      });
      return;
    }
    sendInvoiceEmail.mutate(
      { id: invoice.id, email: customerEmail },
      {
        onSuccess: (res) => toast({ title: "Invoice emailed", description: `Sent to ${res.sentTo}`, variant: "success" }),
        onError: (e: any) => toast({ title: "Failed to send email", description: e?.response?.data?.message || e.message, variant: "error" }),
      },
    );
  };

  const handleReminder = () => {
    const customerEmail = invoice.customer?.email;
    if (!customerEmail) {
      toast({ title: "No email on file", description: "Add an email address to this customer first.", variant: "error" });
      return;
    }
    sendInvoiceReminder.mutate(
      { id: invoice.id, email: customerEmail },
      {
        onSuccess: (res) => toast({ title: "Reminder sent", description: `Reminder emailed to ${res.sentTo}`, variant: "success" }),
        onError: (e: any) => toast({ title: "Failed to send reminder", description: e?.response?.data?.message || e.message, variant: "error" }),
      },
    );
  };

  const handleVoid = () => {
    voidInvoice.mutate(invoice.id, {
      onSuccess: () => {
        setIsVoidOpen(false);
        toast({ title: "Invoice voided", description: `Invoice ${invoice.invoiceNumber} has been voided.`, variant: "info" });
      },
      onError: () => {
        toast({ title: "Failed to void invoice", description: "Please try again.", variant: "error" });
      },
    });
  };

  const handleReopen = () => {
    reopenInvoice.mutate(invoice.id, {
      onSuccess: () => {
        setIsReopenOpen(false);
        toast({ title: "Invoice reopened", description: `Invoice ${invoice.invoiceNumber} has been reopened.`, variant: "success" });
      },
      onError: () => {
        toast({ title: "Failed to reopen invoice", description: "Please try again.", variant: "error" });
      },
    });
  };

  const handleWriteOff = (reason: string) => {
    writeOffInvoice.mutate({ id: invoice.id, reason }, {
      onSuccess: () => {
        setIsWriteOffOpen(false);
        toast({ title: "Invoice written off", description: `Invoice ${invoice.invoiceNumber} marked as written off.`, variant: "info" });
      },
      onError: (err: any) => {
        toast({ title: "Failed to write off invoice", description: err?.response?.data?.message ?? "Please try again.", variant: "error" });
      },
    });
  };

  const handleRecordPayment = (data: PaymentFormState) => {
    recordPayment.mutate(
      { id: invoice.id, method: data.method as "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD", amount: parseFloat(data.amount), reference: data.reference.trim() || undefined, notes: data.notes.trim() || undefined },
      {
        onSuccess: () => {
          setIsPaymentOpen(false);
          toast({ title: "Payment recorded", description: `Payment of ${fmt(parseFloat(data.amount))} recorded.`, variant: "success" });
        },
        onError: (err: any) => {
          toast({ title: "Failed to record payment", description: err?.response?.data?.message ?? "Please try again.", variant: "error" });
        },
      },
    );
  };

  const handleSavePayment = (data: PaymentFormState) => {
    if (!editingPayment) return;
    updatePayment.mutate(
      { invoiceId: invoice.id, paymentId: editingPayment.id, method: data.method as "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD", amount: parseFloat(data.amount), reference: data.reference.trim() || undefined, notes: data.notes.trim() || undefined },
      {
        onSuccess: () => {
          setEditingPayment(null);
          toast({ title: "Payment updated", variant: "success" });
        },
        onError: (err: any) => {
          toast({ title: "Failed to update payment", description: err?.response?.data?.message ?? "Please try again.", variant: "error" });
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
      dueDate: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
      items: (invoice.items ?? []).map((it) => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
      })),
      notes: invoice.notes,
    };
    createInvoice.mutate(dto, {
      onSuccess: (newInv) => {
        toast({ title: "Invoice duplicated", description: `New invoice ${newInv.invoiceNumber} created as a draft.`, variant: "success" });
        router.push(`/invoices/${newInv.id}`);
      },
      onError: () => {
        toast({ title: "Failed to duplicate invoice", variant: "error" });
      },
    });
  };

  const handleDownloadPdf = () => {
    downloadPdf.mutate(invoice.id, {
      onSuccess: ({ url }) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      onError: () => {
        toast({ title: "Failed to generate PDF", description: "Please try again.", variant: "error" });
      },
    });
  };

  // For edit payment: max amount = total - (all other payments)
  const editPaymentMax = editingPayment
    ? total - payments.filter((p) => p.id !== editingPayment.id).reduce((s, p) => s + Number(p.amount), 0)
    : 0;

  return (
    <div className="space-y-4 p-6">
      {/* Back */}
      <Link
        href="/invoices"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Invoices
      </Link>

      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-navy">{invoice.invoiceNumber}</h1>
          <InvoiceStatusBadge status={status} />
        </div>

        {/* Zoho-style action toolbar */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Edit — only for draft */}
          {status === "DRAFT" && (
            <Button size="sm" variant="secondary" leftIcon={<Pencil className="h-3.5 w-3.5" />} href={`/invoices/${invoice.id}/edit`}>
              Edit
            </Button>
          )}

          {/* Send (DRAFT) / Send Reminder (SENT/VIEWED/OVERDUE) */}
          {status === "DRAFT" && (
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

          {/* PDF/Print */}
          {canDownloadPdf && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Download className="h-3.5 w-3.5" />}
              onClick={handleDownloadPdf}
              loading={downloadPdf.isPending}
            >
              PDF
            </Button>
          )}

          {/* Revert to Draft — SENT/VIEWED/OVERDUE with no payments */}
          {(status === "SENT" || status === "VIEWED" || status === "OVERDUE") && amountPaid === 0 && (
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
                <button className="flex items-center gap-1.5 rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy shadow-sm transition-colors hover:bg-surface-raised">
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

          {/* Adjust Prices — operator-only, any non-void status */}
          {status !== "VOID" && status !== "WRITTEN_OFF" && (
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
              <button className="flex items-center justify-center rounded border border-surface-border bg-white p-1.5 shadow-sm transition-colors hover:bg-surface-raised">
                <MoreHorizontal className="h-4 w-4 text-navy/60" />
              </button>
            }
            items={[
              { label: "Duplicate", onClick: handleDuplicate },
              { label: "Reopen Invoice", onClick: () => setIsReopenOpen(true), disabled: status !== "PAID" },
              { label: "Void Invoice", onClick: () => setIsVoidOpen(true), danger: true, disabled: !canVoid },
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Invoice document (2/3) ── */}
        <div className="lg:col-span-2">
          <div className="relative overflow-hidden rounded-xl border border-surface-border bg-white p-8 shadow-[0_2px_12px_0_rgb(0,0,0,0.08)]">
            {/* Status ribbon */}
            <StatusRibbon status={status} />

            {/* Invoice letterhead */}
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
                <p className="text-xl font-bold uppercase tracking-wide text-navy">Invoice</p>
                <p className="mt-0.5 font-mono text-sm text-navy/60">{invoice.invoiceNumber}</p>
                {balanceDue > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">Balance Due</p>
                    <p className="text-2xl font-bold text-danger">{fmt(balanceDue)}</p>
                  </div>
                )}
                {balanceDue === 0 && status === "PAID" && (
                  <div className="mt-2">
                    <p className="text-lg font-bold text-green-600">Paid in Full</p>
                  </div>
                )}
              </div>
            </div>

            {/* Billing + dates */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">Bill To</p>
                <p className="text-sm font-semibold text-navy">{invoice.customer?.businessName ?? "—"}</p>
                {invoice.customer?.contactName && (
                  <p className="text-sm text-navy/60">{invoice.customer.contactName}</p>
                )}
                {invoice.customer?.address && (
                  <p className="mt-1 text-xs text-navy/50 whitespace-pre-line">{invoice.customer.address}</p>
                )}
              </div>
              <div className="text-right space-y-1">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">Invoice Details</p>
                <p className="text-sm text-navy/60">
                  <span className="font-medium text-navy">Issue Date:</span>{" "}
                  {fmtDate(invoice.issueDate ?? invoice.createdAt)}
                </p>
                {invoice.dueDate && (
                  <p className="text-sm text-navy/60">
                    <span className="font-medium text-navy">Due Date:</span>{" "}
                    {fmtDate(invoice.dueDate)}
                  </p>
                )}
                {(invoice as any).terms && (
                  <p className="text-sm text-navy/60">
                    <span className="font-medium text-navy">Terms:</span>{" "}
                    {(invoice as any).terms}
                  </p>
                )}
                {(invoice as any).orderNumber && (
                  <p className="text-sm text-navy/60">
                    <span className="font-medium text-navy">Order #:</span>{" "}
                    {(invoice as any).orderNumber}
                  </p>
                )}
              </div>
            </div>

            {/* Line items table — dark navy header (Zoho style) */}
            <div className="-mx-8 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#1B3A5C]">
                    <th className="px-8 py-3 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                      Description
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                      Qty
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                      Rate
                    </th>
                    <th className="px-8 py-3 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {(invoice.items ?? []).map((item, idx) => (
                    <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/60"}>
                      <td className="px-8 py-3 text-navy">{item.description}</td>
                      <td className="px-4 py-3 text-right text-navy/70">{item.qty}</td>
                      <td className="px-4 py-3 text-right">
                        {item.priceType === 'SPECIAL' ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <span className="text-xs text-navy/40 line-through">{fmt(Number(item.originalPrice))}</span>
                            <span className="font-medium text-emerald-600">{fmt(Number(item.unitPrice))}</span>
                            <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">Special price</span>
                          </div>
                        ) : item.priceType === 'DISCOUNTED' ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <span className="text-xs text-navy/40 line-through">{fmt(Number(item.originalPrice))}</span>
                            <span className="font-medium text-amber-600">{fmt(Number(item.unitPrice))}</span>
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">Discounted price</span>
                          </div>
                        ) : (
                          <span className="text-navy/70">{fmt(Number(item.unitPrice))}</span>
                        )}
                      </td>
                      <td className="px-8 py-3 text-right font-medium text-navy">
                        {fmt(Number(item.qty) * Number(item.unitPrice))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals footer */}
            <div className="mt-4 border-t border-surface-border pt-4">
              <div className="ml-auto w-64 space-y-2 text-sm">
                <div className="flex justify-between text-navy/70">
                  <span>Subtotal</span>
                  <span>{fmt(Number(invoice.subtotal))}</span>
                </div>
                {discount > 0 && (
                  <div className="flex justify-between text-success">
                    <span>Discount</span>
                    <span>-{fmt(discount)}</span>
                  </div>
                )}
                {Number(invoice.taxAmount ?? 0) > 0 && (
                  <div className="flex justify-between text-navy/70">
                    <span>Tax</span>
                    <span>{fmt(Number(invoice.taxAmount))}</span>
                  </div>
                )}
                {shippingFee > 0 && (
                  <div className="flex justify-between text-navy/70">
                    <span>Shipping</span>
                    <span>{fmt(shippingFee)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-navy">
                  <span>Total</span>
                  <span>{fmt(total)}</span>
                </div>
                {amountPaid > 0 && (
                  <div className="flex justify-between text-success">
                    <span className="font-medium">Amount Paid</span>
                    <span className="font-bold">-{fmt(amountPaid)}</span>
                  </div>
                )}
                <div
                  className={cn(
                    "flex justify-between border-t border-surface-border pt-2 text-base font-bold",
                    balanceDue > 0 ? "text-danger" : "text-success",
                  )}
                >
                  <span>Balance Due</span>
                  <span>{fmt(balanceDue)}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div className="mt-6 border-t border-surface-border pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">Notes</p>
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
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-navy/40" />
                <Link
                  href={`/orders/${(invoice as any).orderId}`}
                  className="text-sm text-brand-500 hover:underline"
                >
                  View order →
                </Link>
              </div>
            </Card>
          )}

          {/* Payment history */}
          <Card title="Payment History">
            {payments.length === 0 ? (
              <p className="text-sm text-navy/40">No payments recorded.</p>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {payments.map((pmt) => {
                  const isEditable = pmt.method !== "CREDIT_NOTE" && pmt.method !== "ADVANCE" && status !== "VOID" && status !== "WRITTEN_OFF" && status !== "PAID";
                  return (
                    <li key={pmt.id} className="group flex items-start gap-3 px-6 py-4">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-bg">
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-navy">{fmt(Number(pmt.amount))}</span>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-navy/50">{fmtDate(pmt.createdAt)}</span>
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
                            <span className="text-xs text-navy/50">· {pmt.reference}</span>
                          )}
                        </div>
                        {pmt.notes && <p className="mt-0.5 text-xs text-navy/40">{pmt.notes}</p>}
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
              <div className="flex justify-between">
                <dt className="text-navy/60">Invoice Total</dt>
                <dd className="font-medium text-navy">{fmt(total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Paid</dt>
                <dd className="font-medium text-success">{fmt(amountPaid)}</dd>
              </div>
              <div
                className={cn(
                  "flex justify-between border-t border-surface-border pt-2 font-bold",
                  balanceDue > 0 ? "text-danger" : "text-success",
                )}
              >
                <dt>Balance Due</dt>
                <dd>{fmt(balanceDue)}</dd>
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
            <Button variant="secondary" onClick={() => setIsReopenOpen(false)} disabled={reopenInvoice.isPending}>
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
          Are you sure you want to reopen this invoice? This will change its status back to the appropriate state.
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
            <Button variant="secondary" onClick={() => setIsRevertToDraftOpen(false)} disabled={revertToDraft.isPending}>
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
                  onError: (e: any) => toast({ title: "Failed to revert", description: e?.response?.data?.message ?? "Please try again.", variant: "error" }),
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
          This will undeliver the invoice from the customer. No payments have been recorded, so this is safe to revert.
        </p>
      </Modal>

      <Modal
        open={isUnvoidOpen}
        onClose={() => setIsUnvoidOpen(false)}
        title="Unvoid Invoice?"
        description={`Invoice ${invoice.invoiceNumber} will be moved back to Draft status.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsUnvoidOpen(false)} disabled={unvoid.isPending}>
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
                  onError: (e: any) => toast({ title: "Failed to unvoid", description: e?.response?.data?.message ?? "Please try again.", variant: "error" }),
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
          Are you sure you want to unvoid this invoice? It will return to Draft status and can be edited and re-sent.
        </p>
      </Modal>
    </div>
  );
}
