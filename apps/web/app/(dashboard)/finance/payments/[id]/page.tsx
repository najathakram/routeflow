"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Ban, Printer } from "lucide-react";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useInvoice,
  useInvoicePayments,
  useVoidPayment,
  useGetPaymentImageUrl,
} from "@/lib/api/invoices";
import { Badge, Button, Card, useToast } from "@routeflow/ui/web";
import { fmt, fmtDate } from "@/lib/formatting";
import { paymentMethodLabel } from "@/lib/payment-methods";

const BANK_DATE_HELP =
  "When the funds actually landed in your account — e.g. a post-dated check's clearing date. Leave blank if unknown.";

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

  // Enrich the "Applied Invoice" card with the invoice's own total / balance /
  // status. Guarded below for loading/undefined so the card degrades gracefully.
  const { data: invoice } = useInvoice(payment?.invoice.id ?? "");

  // Receipt image (expense-viewer pattern): resolve the presigned URL once we
  // know the payment has one attached. Called unconditionally (before the
  // loading/not-found early returns) to respect the Rules of Hooks.
  const getPaymentImageUrl = useGetPaymentImageUrl();
  const [receiptUrl, setReceiptUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReceiptUrl(null);
    if (payment?.id && payment.imageKey) {
      getPaymentImageUrl
        .mutateAsync(payment.id)
        .then((r) => setReceiptUrl(r.url))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id, payment?.imageKey]);

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
  const date = fmtDate(payment.paidAt ?? payment.createdAt);
  const hasBankCharges = payment.bankCharges != null && payment.bankCharges > 0;

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/finance/payments"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Payments
      </Link>

      {/* Header (ph-row) */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-2xl font-bold text-navy">
              {payment.paymentNumber ?? "Payment"}
            </h2>
            <Badge status={status as "PAID" | "DRAFT" | "VOID"} />
          </div>
          <p className="mt-1 text-sm text-navy/70">
            Payment received · {payment.invoice.customer?.businessName ?? "—"} · {date}
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {status !== "VOID" && (
            <Button
              size="sm"
              variant="danger"
              leftIcon={<Ban className="h-4 w-4" />}
              onClick={handleVoid}
              loading={voidPayment.isPending}
            >
              Void Payment
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Printer className="h-4 w-4" />}
            onClick={() => window.print()}
          >
            Print receipt
          </Button>
        </div>
      </div>

      {/* Body: doc (1.5fr) + sidebar (1fr) */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* ── Receipt document ── */}
        <Card className="p-8">
          <div className="mb-6">
            <h2 className="display text-[26px]">Payment Receipt</h2>
            <p className="mono mt-1 text-[12.5px] text-navy/70">
              {payment.paymentNumber ? `${payment.paymentNumber} · ` : ""}
              {date}
            </p>
          </div>

          {/* KV grid */}
          <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
              <span className="text-navy/70">Received from</span>
              <span className="text-right font-medium text-navy">
                {payment.invoice.customer?.businessName ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
              <span className="text-navy/70">Payment date</span>
              <span className="text-right font-medium text-navy">{date}</span>
            </div>
            {payment.settledAt && (
              <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
                <span className="text-navy/70" title={BANK_DATE_HELP}>
                  Money received in bank
                </span>
                <span className="text-right font-medium text-navy">
                  {fmtDate(payment.settledAt)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
              <span className="text-navy/70">Payment mode</span>
              <span className="text-right font-medium text-navy">
                {paymentMethodLabel(payment.method)}
              </span>
            </div>
            {payment.reference && (
              <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
                <span className="text-navy/70">Reference</span>
                <span className="mono text-right font-medium text-navy">{payment.reference}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
              <span className="text-navy/70">Applied to</span>
              <Link
                href={`/invoices/${payment.invoice.id}`}
                className="text-right font-medium text-brand-600 hover:underline"
              >
                {payment.invoice.invoiceNumber}
              </Link>
            </div>
          </div>

          {/* Notes */}
          {payment.notes && (
            <div className="mt-6 border-t border-surface-border pt-4">
              <p className="overline mb-1">Notes</p>
              <p className="text-sm text-navy/70 whitespace-pre-line">{payment.notes}</p>
            </div>
          )}

          {/* Totals */}
          <div className="mt-6 flex justify-end">
            <div className="w-full max-w-[300px]">
              <div className="flex justify-between py-1.5 text-[13.5px] text-navy/70">
                <span>Amount received</span>
                <span className="money text-navy">{fmt(payment.amount)}</span>
              </div>
              {hasBankCharges && (
                <div className="flex justify-between py-1.5 text-[13.5px] text-navy/70">
                  <span>Bank charges</span>
                  <span className="money text-danger">− {fmt(payment.bankCharges!)}</span>
                </div>
              )}
              <div className="mt-1.5 flex justify-between border-t border-navy pt-3 text-base font-semibold text-navy">
                <span>Total applied</span>
                <span className="money">{fmt(payment.amount)}</span>
              </div>
            </div>
          </div>
        </Card>

        {/* ── Sidebar ── */}
        <div className="space-y-4">
          <Card title="Applied Invoice">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-navy/70">Invoice</dt>
                <dd>
                  <Link
                    href={`/invoices/${payment.invoice.id}`}
                    className="mono text-brand-600 hover:underline"
                  >
                    {payment.invoice.invoiceNumber}
                  </Link>
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-navy/70">Applied</dt>
                <dd className="money text-success">{fmt(payment.amount)}</dd>
              </div>
              {invoice && (
                <>
                  <div className="flex items-center justify-between">
                    <dt className="text-navy/70">Invoice total</dt>
                    <dd className="money text-navy">{fmt(invoice.total)}</dd>
                  </div>
                  {invoice.balanceDue != null && (
                    <div className="flex items-center justify-between">
                      <dt className="text-navy/70">Remaining balance</dt>
                      <dd className="money text-navy">{fmt(invoice.balanceDue)}</dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <dt className="text-navy/70">Invoice status</dt>
                    <dd>
                      <Badge status={invoice.status} />
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </Card>

          {payment.imageKey && (
            <Card title="Receipt Image">
              {receiptUrl ? (
                <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={receiptUrl}
                    alt="Payment receipt"
                    className="max-h-80 w-full rounded-lg border border-surface-border object-contain"
                  />
                </a>
              ) : (
                <p className="text-sm text-navy/70">Loading receipt…</p>
              )}
            </Card>
          )}

          {status !== "VOID" && (
            <Card className="border border-danger-bg">
              <h3 className="mb-2 text-base font-semibold text-danger">Void</h3>
              <p className="text-[12.5px] leading-relaxed text-navy/70">
                Voiding reverses the application, returns the invoice to its prior balance, and
                keeps this receipt for the audit trail.
              </p>
              <Button
                variant="danger"
                size="sm"
                className="mt-3 w-full"
                leftIcon={<Ban className="h-4 w-4" />}
                onClick={handleVoid}
                loading={voidPayment.isPending}
              >
                Void Payment…
              </Button>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
