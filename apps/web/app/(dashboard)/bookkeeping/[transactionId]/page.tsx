"use client";

import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  Download,
  Plus,
  CheckCircle2,
  CreditCard,
  Loader2,
} from "lucide-react";
import { Badge, Button, Card, Modal, Input, Select, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useTransaction, useRecordPayment, useDownloadInvoice, type Payment } from "@/lib/api/bookkeeping";

// ─── Payment status badge ─────────────────────────────────────────────────────

type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  if (status === "PAID") return <Badge variant="success" label="Paid" />;
  if (status === "PARTIAL") return <Badge variant="warning" label="Partial" />;
  return <Badge variant="neutral" label="Unpaid" />;
}

// ─── Record payment schema ────────────────────────────────────────────────────

const paymentSchema = z.object({
  method: z.enum(["CASH", "CHECK", "ACH", "OTHER"]),
  amount: z.coerce.number().positive("Enter an amount greater than 0"),
  reference: z.string().optional(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

// ─── Record payment modal ─────────────────────────────────────────────────────

function RecordPaymentModal({
  isOpen,
  onClose,
  onRecord,
  remaining,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onRecord: (data: PaymentFormValues) => void;
  remaining: number;
  isPending: boolean;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { method: "ACH", amount: remaining > 0 ? parseFloat(remaining.toFixed(2)) : 0 },
  });

  React.useEffect(() => {
    if (isOpen) reset({ method: "ACH", amount: remaining > 0 ? parseFloat(remaining.toFixed(2)) : 0 });
  }, [isOpen, remaining, reset]);

  const onSubmit = (data: PaymentFormValues) => {
    onRecord(data);
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Record Payment"
      description="Log a payment received for this invoice."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="payment-form" loading={isPending}>
            Record Payment
          </Button>
        </>
      }
    >
      <form id="payment-form" onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <Select
          label="Payment Method"
          options={[
            { value: "CASH", label: "Cash" },
            { value: "CHECK", label: "Check" },
            { value: "ACH", label: "ACH / Bank Transfer" },
            { value: "OTHER", label: "Other" },
          ]}
          register={register("method")}
          error={errors.method?.message}
        />
        <Input
          label="Amount ($)"
          type="number"
          step="0.01"
          min="0.01"
          placeholder="0.00"
          register={register("amount")}
          error={errors.amount?.message}
        />
        <Input
          label="Reference # (optional)"
          placeholder="Check number, ACH ID…"
          register={register("reference")}
          error={errors.reference?.message}
        />
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TransactionDetailPage({ params }: { params: { transactionId: string } }) {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data: txn, isLoading, isError } = useTransaction(params.transactionId);
  const recordPayment = useRecordPayment();
  const downloadInvoice = useDownloadInvoice();
  const [isPaymentOpen, setIsPaymentOpen] = React.useState(false);

  const handleDownloadPdf = () => {
    downloadInvoice.mutate(params.transactionId, {
      onSuccess: (result) => {
        if (!result) {
          toast({
            title: "PDF generating",
            description: "Your invoice PDF is being generated. Check back in a moment.",
          });
        } else {
          window.open(result.url, "_blank");
        }
      },
      onError: () => {
        toast({
          title: "Download failed",
          description: "Unable to retrieve the invoice PDF. Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  React.useEffect(() => {
    if (txn) {
      setTitle(txn.order?.orderNumber ?? "Invoice");
    }
  }, [txn, setTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
      </div>
    );
  }

  if (isError || !txn) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Invoice not found.</p>
        <Button variant="secondary" href="/bookkeeping">Back to Bookkeeping</Button>
      </div>
    );
  }

  const total = Number(txn.totalOwed);
  const paid = Number(txn.totalPaid);
  const bal = total - paid;
  const payments: Payment[] = txn.payments ?? [];

  const localStatus: PaymentStatus = bal <= 0 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";

  const handleRecord = (data: PaymentFormValues) => {
    recordPayment.mutate(
      { id: txn.id, amount: data.amount, method: data.method, reference: data.reference },
      { onSuccess: () => setIsPaymentOpen(false) },
    );
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/bookkeeping"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Bookkeeping
      </Link>

      {/* Action row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-navy">{txn.order?.orderNumber ?? txn.id}</h1>
          <PaymentStatusBadge status={localStatus} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={
              downloadInvoice.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )
            }
            onClick={handleDownloadPdf}
            disabled={downloadInvoice.isPending}
          >
            {downloadInvoice.isPending ? "Loading…" : "Download PDF"}
          </Button>
          {localStatus !== "PAID" && (
            <Button
              size="sm"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setIsPaymentOpen(true)}
            >
              Record Payment
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">

        {/* ── Invoice card (2/3 width) ── */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            {/* Invoice header */}
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
                <p className="mt-1 font-mono text-sm text-navy/60">{txn.order?.orderNumber ?? txn.id}</p>
              </div>
            </div>

            {/* Billing info */}
            <div className="mb-6 grid grid-cols-2 gap-6 border-t border-surface-border pt-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">Bill To</p>
                <p className="text-sm font-semibold text-navy">{txn.customer?.businessName ?? "—"}</p>
                {txn.customer?.contactName && (
                  <p className="text-sm text-navy/60">{txn.customer.contactName}</p>
                )}
              </div>
              <div className="text-right">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/40">Invoice Details</p>
                <p className="text-sm text-navy/60">
                  <span className="font-medium text-navy">Date:</span>{" "}
                  {new Date(txn.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </p>
                {txn.dueDate && (
                  <p className="text-sm text-navy/60">
                    <span className="font-medium text-navy">Due:</span>{" "}
                    {new Date(txn.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                )}
              </div>
            </div>

            {/* Totals */}
            <div className="mt-4 border-t border-surface-border pt-4">
              <div className="ml-auto w-56 space-y-2 text-sm">
                <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-navy">
                  <span>Total</span>
                  <span>${total.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-success">
                  <span className="font-medium">Amount Paid</span>
                  <span className="font-bold">-${paid.toFixed(2)}</span>
                </div>
                <div className={cn(
                  "flex justify-between border-t border-surface-border pt-2 text-base font-bold",
                  bal > 0 ? "text-danger" : "text-success",
                )}>
                  <span>Balance Due</span>
                  <span>${bal.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* ── Payment history sidebar ── */}
        <div className="space-y-4">
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
                          ${Number(pmt.amount).toFixed(2)}
                        </span>
                        <span className="text-xs text-navy/50">
                          {new Date(pmt.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-navy/60">
                        {pmt.method}
                        {pmt.reference && ` · ${pmt.reference}`}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {localStatus !== "PAID" && (
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
                <dt className="text-navy/60">Invoice total</dt>
                <dd className="font-medium text-navy">${total.toFixed(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Paid</dt>
                <dd className="font-medium text-success">${paid.toFixed(2)}</dd>
              </div>
              <div className={cn(
                "flex justify-between border-t border-surface-border pt-2 font-bold",
                bal > 0 ? "text-danger" : "text-success",
              )}>
                <dt>Balance due</dt>
                <dd>${bal.toFixed(2)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      <RecordPaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        onRecord={handleRecord}
        remaining={bal}
        isPending={recordPayment.isPending}
      />
    </div>
  );
}
