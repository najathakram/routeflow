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
} from "lucide-react";
import { Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useInvoice,
  useSendInvoice,
  useVoidInvoice,
  useRecordInvoicePayment,
  useCreateInvoice,
  type Invoice,
  type InvoiceStatus,
  type InvoicePayment,
} from "@/lib/api/invoices";
import { useRouter } from "next/navigation";

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

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  SENT: "bg-blue-100 text-blue-700",
  VIEWED: "bg-purple-100 text-purple-700",
  PARTIAL: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
  OVERDUE: "bg-red-100 text-red-600",
};

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
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

// ─── Record payment modal ─────────────────────────────────────────────────────

interface PaymentFormState {
  method: "CASH" | "CHECK" | "ACH" | "OTHER";
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
            <option value="OTHER">Other</option>
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Amount ($)
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InvoiceDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: invoice, isLoading, isError } = useInvoice(params.id);
  const sendInvoice = useSendInvoice();
  const voidInvoice = useVoidInvoice();
  const recordPayment = useRecordInvoicePayment();
  const createInvoice = useCreateInvoice();

  const [isPaymentOpen, setIsPaymentOpen] = React.useState(false);
  const [isVoidOpen, setIsVoidOpen] = React.useState(false);

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
  const balanceDue = Math.max(0, total - amountPaid);
  const status = invoice.status;

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleSend = () => {
    sendInvoice.mutate(invoice.id, {
      onSuccess: () => {
        toast({
          title: "Invoice sent",
          description: `Invoice ${invoice.invoiceNumber} has been sent to the customer.`,
          variant: "success",
        });
      },
      onError: () => {
        toast({
          title: "Failed to send invoice",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
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

  const handleRecordPayment = (data: PaymentFormState) => {
    recordPayment.mutate(
      {
        id: invoice.id,
        method: data.method,
        amount: parseFloat(data.amount),
        reference: data.reference.trim() || undefined,
        notes: data.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setIsPaymentOpen(false);
          toast({
            title: "Payment recorded",
            description: `Payment of ${fmt.format(parseFloat(data.amount))} recorded.`,
            variant: "success",
          });
        },
        onError: () => {
          toast({
            title: "Failed to record payment",
            description: "Please try again.",
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
    toast({
      title: "PDF download",
      description: "Invoice PDF download is not yet available.",
      variant: "info",
    });
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/invoices"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Invoices
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-navy">{invoice.invoiceNumber}</h1>
          <InvoiceStatusBadge status={status} />
        </div>

        {/* Action buttons based on status */}
        <div className="flex flex-wrap items-center gap-2">
          {/* DRAFT actions */}
          {status === "DRAFT" && (
            <>
              <Button
                size="sm"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={handleSend}
                loading={sendInvoice.isPending}
              >
                Send Invoice
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Pencil className="h-4 w-4" />}
                href={`/invoices/${invoice.id}/edit`}
              >
                Edit
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

          {/* SENT / VIEWED actions */}
          {(status === "SENT" || status === "VIEWED") && (
            <>
              <Button
                size="sm"
                leftIcon={<CreditCard className="h-4 w-4" />}
                onClick={() => setIsPaymentOpen(true)}
              >
                Record Payment
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={handleSend}
                loading={sendInvoice.isPending}
              >
                Send Reminder
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

          {/* PARTIAL / OVERDUE actions */}
          {(status === "PARTIAL" || status === "OVERDUE") && (
            <>
              <Button
                size="sm"
                leftIcon={<CreditCard className="h-4 w-4" />}
                onClick={() => setIsPaymentOpen(true)}
              >
                Record Payment
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

          {/* PAID actions */}
          {status === "PAID" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Download className="h-4 w-4" />}
                onClick={handleDownloadPdf}
              >
                Download PDF
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Copy className="h-4 w-4" />}
                onClick={handleDuplicate}
                loading={createInvoice.isPending}
              >
                Duplicate
              </Button>
            </>
          )}

          {/* VOID — read-only indicator */}
          {status === "VOID" && (
            <span className="text-sm italic text-navy/40">This invoice is void.</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Invoice preview (2/3) ── */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
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
                <p className="text-xl font-bold text-navy">INVOICE</p>
                <p className="mt-1 font-mono text-sm text-navy/60">{invoice.invoiceNumber}</p>
              </div>
            </div>

            {/* Billing + dates */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                  Bill To
                </p>
                <p className="text-sm font-semibold text-navy">
                  {invoice.customer?.businessName ?? "—"}
                </p>
                {invoice.customer?.contactName && (
                  <p className="text-sm text-navy/60">{invoice.customer.contactName}</p>
                )}
                {invoice.customer?.address && (
                  <p className="mt-1 text-xs text-navy/50 whitespace-pre-line">
                    {invoice.customer.address}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                  Invoice Details
                </p>
                <p className="text-sm text-navy/60">
                  <span className="font-medium text-navy">Issue Date:</span>{" "}
                  {fmtDate((invoice as any).issueDate ?? invoice.createdAt)}
                </p>
                <p className="text-sm text-navy/60">
                  <span className="font-medium text-navy">Due Date:</span>{" "}
                  {fmtDate(invoice.dueDate)}
                </p>
              </div>
            </div>

            {/* Line items table */}
            <div className="-mx-6 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised">
                  <tr>
                    <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/60">
                      Description
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/60">
                      Qty
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/60">
                      Unit Price
                    </th>
                    <th className="px-6 py-2.5 text-right text-xs font-medium text-navy/60">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {invoice.items.map((item) => (
                    <tr key={item.id} className="hover:bg-surface-raised">
                      <td className="px-6 py-3 text-navy">
                        {item.description}
                      </td>
                      <td className="px-4 py-3 text-right text-navy/70">{item.qty}</td>
                      <td className="px-4 py-3 text-right text-navy/70">
                        {fmt.format(Number(item.unitPrice))}
                      </td>
                      <td className="px-6 py-3 text-right font-medium text-navy">
                        {fmt.format(Number(item.qty) * Number(item.unitPrice))}
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
                  <span>{fmt.format(Number(invoice.subtotal))}</span>
                </div>
                <div className="flex justify-between text-navy/70">
                  <span>Tax</span>
                  <span>{fmt.format(Number(invoice.taxAmount ?? 0))}</span>
                </div>
                <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-navy">
                  <span>Total</span>
                  <span>{fmt.format(total)}</span>
                </div>
                {amountPaid > 0 && (
                  <div className="flex justify-between text-success">
                    <span className="font-medium">Amount Paid</span>
                    <span className="font-bold">-{fmt.format(amountPaid)}</span>
                  </div>
                )}
                <div
                  className={cn(
                    "flex justify-between border-t border-surface-border pt-2 text-base font-bold",
                    balanceDue > 0 ? "text-danger" : "text-success",
                  )}
                >
                  <span>Balance Due</span>
                  <span>{fmt.format(balanceDue)}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">
                  Notes
                </p>
                <p className="text-sm text-navy/70 whitespace-pre-line">{invoice.notes}</p>
              </div>
            )}
          </Card>
        </div>

        {/* ── Sidebar (1/3) ── */}
        <div className="space-y-4">
          {/* Payment history */}
          <Card title="Payment History">
            {payments.length === 0 ? (
              <p className="text-sm text-navy/40">No payments recorded.</p>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {payments.map((pmt) => (
                  <li key={pmt.id} className="flex items-start gap-3 px-6 py-4">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-bg">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-navy">
                          {fmt.format(Number(pmt.amount))}
                        </span>
                        <span className="text-xs text-navy/50">
                          {fmtDate(pmt.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-navy/60">
                        {pmt.method}
                        {pmt.reference && ` · ${pmt.reference}`}
                      </p>
                      {pmt.notes && (
                        <p className="mt-0.5 text-xs text-navy/40">{pmt.notes}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(status === "SENT" ||
              status === "VIEWED" ||
              status === "PARTIAL" ||
              status === "OVERDUE") && (
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
                <dd className="font-medium text-navy">{fmt.format(total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Paid</dt>
                <dd className="font-medium text-success">{fmt.format(amountPaid)}</dd>
              </div>
              <div
                className={cn(
                  "flex justify-between border-t border-surface-border pt-2 font-bold",
                  balanceDue > 0 ? "text-danger" : "text-success",
                )}
              >
                <dt>Balance Due</dt>
                <dd>{fmt.format(balanceDue)}</dd>
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

      <VoidConfirmModal
        isOpen={isVoidOpen}
        onClose={() => setIsVoidOpen(false)}
        onConfirm={handleVoid}
        invoiceNumber={invoice.invoiceNumber}
        isPending={voidInvoice.isPending}
      />
    </div>
  );
}
