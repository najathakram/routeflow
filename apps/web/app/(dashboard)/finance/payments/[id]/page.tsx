"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import { usePageTitle } from "@/lib/page-title-context";
import { useInvoicePayments, useVoidPayment } from "@/lib/api/invoices";
import { useToast } from "@routeflow/ui/web";
import Link from "next/link";
import { fmt, fmtDate } from "@/lib/formatting";

const METHOD_LABELS: Record<string, string> = {
  CASH: "Cash",
  CHECK: "Check",
  ACH: "ACH / Bank Transfer",
  CREDIT_CARD: "Credit Card",
  OTHER: "Other",
  CREDIT_NOTE: "Credit Note",
  ADVANCE: "Advance",
};
const STATUS_STYLES: Record<string, string> = {
  PAID: "bg-success-bg text-success",
  DRAFT: "bg-warning-bg text-warning",
  VOID: "bg-surface-raised text-navy/70",
};

export default function PaymentDetailPage() {
  const { setTitle } = usePageTitle();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();

  // Fetch the payment by searching all payments by id — use list with no filters,
  // since we don't have a single-payment endpoint yet.
  // We'll fetch a large page and find the matching one.
  const { data, isLoading } = useInvoicePayments({ limit: 200 });
  const voidPayment = useVoidPayment();

  React.useEffect(() => {
    setTitle("Payment Receipt");
  }, [setTitle]);

  const payment = data?.data.find((p) => p.id === id);

  const handleVoid = async () => {
    if (!payment) return;
    if (
      !confirm("Void this payment? This reverses its effect on the invoice and cannot be undone.")
    )
      return;
    try {
      await voidPayment.mutateAsync({ invoiceId: payment.invoice.id, paymentId: payment.id });
      toast({ title: "Payment voided", variant: "success" });
    } catch {
      toast({ title: "Failed to void payment", variant: "error" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center p-6">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-navy/70">Payment not found.</p>
        <button onClick={() => router.back()} className="text-brand-500 hover:underline text-sm">
          ← Back
        </button>
      </div>
    );
  }

  const status = payment.status ?? "PAID";

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      {/* Back + actions */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.push("/finance/payments")}
          className="text-sm text-navy/70 hover:text-navy"
        >
          ← Back to Payments
        </button>
        <div className="flex gap-2">
          {status !== "VOID" && (
            <button
              onClick={handleVoid}
              disabled={voidPayment.isPending}
              className="rounded-lg border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger-bg transition-colors disabled:opacity-50"
            >
              {voidPayment.isPending ? "Voiding..." : "Void Payment"}
            </button>
          )}
        </div>
      </div>

      {/* Receipt card */}
      <div className="rounded-2xl border border-surface-border bg-white shadow-card overflow-hidden">
        {/* Receipt header */}
        <div className="bg-surface-raised border-b border-surface-border px-6 py-5 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-navy">Payment Receipt</h1>
            {payment.paymentNumber && (
              <p className="font-mono text-sm text-navy/70 mt-0.5">{payment.paymentNumber}</p>
            )}
          </div>
          <span
            className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ${STATUS_STYLES[status]}`}
          >
            {status}
          </span>
        </div>

        {/* Customer + date row */}
        <div className="grid grid-cols-2 gap-6 px-6 py-5 border-b border-surface-border">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
              Received From
            </p>
            <p className="mt-1 font-semibold text-navy">
              {payment.invoice.customer?.businessName ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">Payment Date</p>
            <p className="mt-1 font-semibold text-navy">
              {fmtDate(payment.paidAt ?? payment.createdAt)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">Payment Mode</p>
            <p className="mt-1 font-semibold text-navy">
              {METHOD_LABELS[payment.method] ?? payment.method}
            </p>
          </div>
          {payment.reference && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
                Reference #
              </p>
              <p className="mt-1 font-semibold text-navy">{payment.reference}</p>
            </div>
          )}
        </div>

        {/* Applied to invoice(s) */}
        <div className="px-6 py-5 border-b border-surface-border">
          <p className="text-xs font-medium uppercase tracking-wide text-navy/70 mb-3">
            Applied to Invoice
          </p>
          <div className="flex items-center justify-between rounded-lg bg-surface-raised px-4 py-3">
            <div>
              <Link
                href={`/invoices/${payment.invoice.id}`}
                className="font-medium text-brand-600 hover:underline"
              >
                {payment.invoice.invoiceNumber}
              </Link>
              <p className="text-xs text-navy/70 mt-0.5">
                {payment.invoice.customer?.businessName}
              </p>
            </div>
            <span className="font-semibold text-navy">{fmt(payment.amount)}</span>
          </div>
        </div>

        {/* Totals */}
        <div className="px-6 py-5 space-y-2">
          <div className="flex justify-between text-sm text-navy/70">
            <span>Amount Received</span>
            <span>{fmt(payment.amount)}</span>
          </div>
          {payment.bankCharges && payment.bankCharges > 0 && (
            <div className="flex justify-between text-sm text-navy/70">
              <span>Bank Charges</span>
              <span className="text-danger">− {fmt(payment.bankCharges)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-surface-border pt-2 font-semibold text-navy">
            <span>Total Applied</span>
            <span className="text-success">{fmt(payment.amount)}</span>
          </div>
        </div>

        {/* Notes */}
        {payment.notes && (
          <div className="border-t border-surface-border px-6 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70 mb-1">Notes</p>
            <p className="text-sm text-navy/70">{payment.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}
