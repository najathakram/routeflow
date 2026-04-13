"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  Calendar,
  DollarSign,
  Download,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { Badge } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerInvoice } from "@/lib/api/buyer";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function getStatusVariant(s: string): "success" | "warning" | "danger" | "neutral" {
  if (s === "PAID") return "success";
  if (s === "SENT" || s === "VIEWED" || s === "PARTIAL") return "warning";
  if (s === "OVERDUE" || s === "VOID" || s === "WRITTEN_OFF") return "danger";
  return "neutral";
}

export default function BuyerInvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;
  const invoiceId = params.id as string;

  const { data: invoice, isLoading, isError } = useBuyerInvoice(invoiceId);

  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (isError || !invoice) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> Failed to load invoice.
        </div>
      </div>
    );
  }

  const totalPaid = invoice.payments?.reduce((s, p) => s + Number(p.amount), 0) ?? 0;
  const balanceDue = Number(invoice.total) - totalPaid;

  return (
    <div className="p-6 max-w-4xl">
      <button
        onClick={() => router.push(`/buyer/portal/${sellerSlug}/invoices`)}
        className="mb-4 flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Invoices
      </button>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy">{invoice.invoiceNumber}</h1>
          <p className="text-sm text-navy/60 mt-1">
            Issued {formatDate(invoice.issueDate)} · Due {formatDate(invoice.dueDate)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={getStatusVariant(invoice.status)}>
            {invoice.status.replace(/_/g, " ")}
          </Badge>
          {invoice.pdfUrl && (
            <a
              href={invoice.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-navy hover:bg-surface-raised transition-colors"
            >
              <Download className="h-4 w-4" /> PDF
            </a>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "Subtotal", value: fmt(Number(invoice.subtotal)), icon: FileText },
          { label: "Tax", value: fmt(Number(invoice.taxAmount)), icon: FileText },
          { label: "Total", value: fmt(Number(invoice.total)), icon: DollarSign },
          {
            label: "Balance Due",
            value: fmt(balanceDue),
            icon: balanceDue > 0 ? Clock : CheckCircle2,
          },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-surface-border bg-white p-4">
            <div className="flex items-center gap-2 text-xs text-navy/50 mb-1">
              <card.icon className="h-3.5 w-3.5" />
              {card.label}
            </div>
            <p className="text-lg font-bold text-navy">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Line items */}
      <div className="rounded-xl border border-surface-border bg-white overflow-hidden mb-6">
        <div className="border-b border-surface-border bg-surface-raised px-4 py-3">
          <h2 className="text-sm font-semibold text-navy">
            Items ({invoice.items?.length ?? 0})
          </h2>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-border text-xs text-navy/50 uppercase tracking-wider">
              <th className="px-4 py-2.5 text-left">Description</th>
              <th className="px-4 py-2.5 text-right w-20">Qty</th>
              <th className="px-4 py-2.5 text-right w-28">Unit Price</th>
              <th className="px-4 py-2.5 text-right w-28">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {(invoice.items ?? []).map((item) => (
              <tr key={item.id} className="hover:bg-surface-raised/50">
                <td className="px-4 py-3 text-sm font-medium text-navy">{item.description}</td>
                <td className="px-4 py-3 text-right text-sm text-navy">{Number(item.qty)}</td>
                <td className="px-4 py-3 text-right text-sm text-navy/70">{fmt(Number(item.unitPrice))}</td>
                <td className="px-4 py-3 text-right text-sm font-medium text-navy">{fmt(Number(item.subtotal))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Payment history */}
      {invoice.payments && invoice.payments.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-white overflow-hidden mb-6">
          <div className="border-b border-surface-border bg-surface-raised px-4 py-3">
            <h2 className="text-sm font-semibold text-navy">
              Payment History ({invoice.payments.length})
            </h2>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-border text-xs text-navy/50 uppercase tracking-wider">
                <th className="px-4 py-2.5 text-left">Date</th>
                <th className="px-4 py-2.5 text-left">Method</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {invoice.payments.map((p) => (
                <tr key={p.id} className="hover:bg-surface-raised/50">
                  <td className="px-4 py-3 text-sm text-navy">{formatDate(p.recordedAt)}</td>
                  <td className="px-4 py-3 text-sm text-navy/70">{p.method.replace(/_/g, " ")}</td>
                  <td className="px-4 py-3 text-right text-sm font-medium text-success">{fmt(Number(p.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Notes */}
      {invoice.notes && (
        <div className="rounded-xl border border-surface-border bg-white p-4 mb-6">
          <p className="text-xs text-navy/50 mb-1">Notes</p>
          <p className="text-sm text-navy">{invoice.notes}</p>
        </div>
      )}

      {/* Terms */}
      {invoice.terms && (
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs text-navy/50 mb-1">Terms &amp; Conditions</p>
          <p className="text-sm text-navy">{invoice.terms}</p>
        </div>
      )}
    </div>
  );
}
