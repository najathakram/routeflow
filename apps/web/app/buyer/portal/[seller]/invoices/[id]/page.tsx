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
import { Badge, useToast } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerInvoice } from "@/lib/api/buyer";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { fetchPdfBlob } from "@/lib/fetch-pdf-blob";
import { checkBadgeFor } from "@/lib/check-badge";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDate(d: string | null) {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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
  const { toast } = useToast();
  const [pdfDownloading, setPdfDownloading] = React.useState(false);

  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  /**
   * Download the invoice PDF via auth-fetched blob.
   *
   * `invoice.pdfUrl` from the API may be either a presigned R2 URL (no auth
   * needed) or a local-storage `https://api…/api/v1/uploads/...` URL behind
   * the JWT-protected uploads endpoint. A plain `<a href={pdfUrl}>` strips
   * the buyer's Bearer token because top-level navigation doesn't carry
   * `localStorage`-held credentials, returning 401 in production.
   *
   * `fetchPdfBlob` picks the right transport: same-origin → buyerApiClient
   * (auto-attaches JWT); external presigned URL → bare axios.
   */
  async function handleDownloadPdf() {
    if (!invoice?.pdfUrl) return;
    setPdfDownloading(true);
    try {
      const blob = await fetchPdfBlob(invoice.pdfUrl, buyerApiClient);
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${invoice.invoiceNumber || invoice.id}.pdf`;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after the browser has had a chance to start the download.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast({
        title: "Couldn't download PDF",
        description:
          status === 401 ? "Please refresh the page and try again." : "Try again in a moment.",
        variant: "error",
      });
    } finally {
      setPdfDownloading(false);
    }
  }

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

  // P5-12: VOID payments (manually voided OR bounced checks) must not count
  // toward the paid amount — a bounce re-opens the balance shown here.
  const totalPaid =
    invoice.payments
      ?.filter((p) => p.status !== "VOID")
      .reduce((s, p) => s + Number(p.amount), 0) ?? 0;
  const balanceDue = Number(invoice.total) - totalPaid;

  return (
    <div className="p-6 max-w-4xl">
      <button
        onClick={() => router.push(`/buyer/portal/${sellerSlug}/invoices`)}
        className="mb-4 flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Invoices
      </button>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy">{invoice.invoiceNumber}</h1>
          <p className="text-sm text-navy/70 mt-1">
            Issued {formatDate(invoice.issueDate)} · Due {formatDate(invoice.dueDate)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={getStatusVariant(invoice.status)}>
            {invoice.status.replace(/_/g, " ")}
          </Badge>
          {invoice.pdfUrl && (
            <button
              type="button"
              onClick={() => void handleDownloadPdf()}
              disabled={pdfDownloading}
              className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-navy transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pdfDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              PDF
            </button>
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
            <div className="flex items-center gap-2 text-xs text-navy/70 mb-1">
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
          <h2 className="text-sm font-semibold text-navy">Items ({invoice.items?.length ?? 0})</h2>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-border text-xs text-navy/70 uppercase tracking-wider">
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
                <td className="px-4 py-3 text-right text-sm text-navy">
                  {Number(item.qty)}
                  {/* BUY_N_GET_M: name the free units, or the reduced subtotal
                      reads as a pricing error. */}
                  {Number(item.promoFreeUnits ?? 0) > 0 && (
                    <p className="mt-0.5 inline-flex items-center rounded-full bg-buyer-50 px-1.5 py-0.5 text-[10px] font-semibold text-buyer-700">
                      {Number(item.promoFreeUnits)} free
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-sm text-navy/70">
                  {fmt(Number(item.unitPrice))}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                  {fmt(Number(item.subtotal))}
                </td>
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
              <tr className="border-b border-surface-border text-xs text-navy/70 uppercase tracking-wider">
                <th className="px-4 py-2.5 text-left">Date</th>
                <th className="px-4 py-2.5 text-left">Method</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {invoice.payments.map((p) => {
                const badge = checkBadgeFor(p);
                const voided = p.status === "VOID";
                return (
                  <tr key={p.id} className="hover:bg-surface-raised/50">
                    <td className="px-4 py-3 text-sm text-navy">
                      {formatDate(p.paidAt ?? p.createdAt ?? null)}
                    </td>
                    <td className="px-4 py-3 text-sm text-navy/70">
                      {p.method.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm font-medium ${
                        voided ? "text-danger line-through" : "text-success"
                      }`}
                    >
                      {fmt(Number(p.amount))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Notes */}
      {invoice.notes && (
        <div className="rounded-xl border border-surface-border bg-white p-4 mb-6">
          <p className="text-xs text-navy/70 mb-1">Notes</p>
          <p className="text-sm text-navy">{invoice.notes}</p>
        </div>
      )}

      {/* Terms */}
      {invoice.terms && (
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs text-navy/70 mb-1">Terms &amp; Conditions</p>
          <p className="text-sm text-navy">{invoice.terms}</p>
        </div>
      )}
    </div>
  );
}
