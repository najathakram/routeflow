"use client";

import * as React from "react";
import {
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Send,
  X,
  Printer,
  Download,
  CheckCircle2,
} from "lucide-react";
import { Modal, cn, TAP_TARGET, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { printPdfBlob } from "@/lib/print-pdf-blob";
import { fetchPdfBlob } from "@/lib/fetch-pdf-blob";
import { formatMoney } from "@/lib/format";
import { markSentErrorText, sendEmailErrorText } from "@/lib/order-error-text";
import { useSendInvoice, useSendInvoiceEmail } from "@/lib/api/invoices";

// ─── Send Invoice Modal ────────────────────────────────────────────────────────

export interface InvoiceModalData {
  invoiceId: string;
  invoiceNumber: string;
  total: number;
  customerName: string;
  customerPhone?: string | null;
  customerMobile?: string | null;
  customerEmail?: string | null;
  /**
   * #2089: true when `postDeliveryInvoicePrompt` returned "issue-and-send" — this
   * is still a DRAFT, and `useSendInvoice`/`useSendInvoiceEmail` issue it
   * (DRAFT → SENT) in the same call. The modal says so instead of "Mark as Sent",
   * which would misleadingly imply it was already issued.
   */
  issuePrompt?: boolean;
}

export function SendInvoiceModal({
  data,
  onClose,
}: {
  data: InvoiceModalData;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const sendInvoice = useSendInvoice({ localErrorToast: true });
  const sendInvoiceEmail = useSendInvoiceEmail({ localErrorToast: true });
  const [pdfLoading, setPdfLoading] = React.useState(false);
  const [printLoading, setPrintLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [emailSent, setEmailSent] = React.useState(false);

  const phone = data.customerMobile || data.customerPhone;
  const totalFmt = formatMoney(data.total);
  const invoiceMsg = encodeURIComponent(
    `Hi ${data.customerName}, your invoice ${data.invoiceNumber} for ${totalFmt} is ready. Please let us know if you have any questions.`,
  );

  async function handleSend() {
    sendInvoice.mutate(data.invoiceId, {
      onSuccess: () => {
        setSent(true);
        toast({ title: "Invoice marked as sent", variant: "success" });
      },
      onError: (e) =>
        toast({
          title: "Couldn't mark the invoice as sent",
          description: markSentErrorText(e),
          variant: "error",
        }),
    });
  }

  function handleSendEmail() {
    sendInvoiceEmail.mutate(
      { id: data.invoiceId, email: data.customerEmail! },
      {
        onSuccess: (res) => {
          setEmailSent(true);
          setSent(true);
          toast({
            title: "Invoice emailed",
            description: `Sent to ${res.sentTo}`,
            variant: "success",
          });
        },
        onError: (e: any) =>
          toast({
            title: "Failed to send email",
            description: sendEmailErrorText(e),
            variant: "error",
          }),
      },
    );
  }

  async function handleDownload() {
    setPdfLoading(true);
    try {
      // Two-step: ask the API to render the PDF, then fetch the bytes.
      // Cannot `window.open(url)` directly — the storage endpoint requires a
      // JWT (RF-075) and a top-level new-tab navigation has no token in
      // localStorage scope, so it returns 401. `fetchPdfBlob` (not bare
      // apiClient — review finding F3) picks the right transport: same-origin
      // → auth'd apiClient; external presigned URL → bare axios, so the JWT
      // is never sent to a third-party host.
      const meta = await apiClient.get<{ url: string }>(`/invoices/${data.invoiceId}/pdf`);
      if (!meta.data?.url) throw new Error("No PDF URL returned");
      const blob = await fetchPdfBlob(meta.data.url, apiClient);
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `invoice-${data.invoiceId}.pdf`;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch {
      toast({ title: "Could not generate PDF", variant: "error" });
    } finally {
      setPdfLoading(false);
    }
  }

  async function handlePrint() {
    setPrintLoading(true);
    try {
      // Mirrors handleDownload's two-step fetch (RF-075 — the storage URL
      // still requires a JWT; fetchPdfBlob, not bare apiClient — review
      // finding F3), then hands the bytes to the shared print helper
      // instead of triggering a download.
      const meta = await apiClient.get<{ url: string }>(`/invoices/${data.invoiceId}/pdf`);
      if (!meta.data?.url) throw new Error("No PDF URL returned");
      const blob = await fetchPdfBlob(meta.data.url, apiClient);
      printPdfBlob(blob);
    } catch {
      toast({ title: "Could not generate PDF", variant: "error" });
    } finally {
      setPrintLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-surface-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-navy">
              {data.issuePrompt ? "Issue & Send Invoice" : "Invoice Ready"}
            </h2>
            <p className="mt-0.5 text-sm text-navy/70">
              {data.invoiceNumber} · {totalFmt} · {data.customerName}
            </p>
          </div>
          <button
            onClick={onClose}
            title="Close"
            className={cn(TAP_TARGET, "rounded text-navy/70 hover:text-navy transition-colors")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Options */}
        <div className="px-5 py-4 space-y-2">
          {sent ? (
            <div className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Invoice marked as sent
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={sendInvoice.isPending}
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-brand-50 hover:border-brand-300 disabled:opacity-50"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-100">
                {sendInvoice.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
                ) : (
                  <Send className="h-4 w-4 text-brand-600" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-navy">
                  {data.issuePrompt ? "Issue & Mark as Sent" : "Mark as Sent"}
                </p>
                <p className="text-xs text-navy/70">
                  {data.issuePrompt
                    ? "Issues the draft invoice and records it sent to customer"
                    : "Record invoice as sent to customer"}
                </p>
              </div>
            </button>
          )}

          {/* WhatsApp */}
          {phone && (
            <a
              href={`https://wa.me/${phone.replace(/\D/g, "")}?text=${invoiceMsg}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-[#e7f9e7] hover:border-[#25D366]/40"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e7f9e7]">
                <MessageCircle className="h-4 w-4 text-[#25D366]" />
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Send via WhatsApp</p>
                <p className="text-xs text-navy/70">{phone}</p>
              </div>
            </a>
          )}

          {/* Email */}
          {data.customerEmail &&
            (emailSent ? (
              <div className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-sm font-medium text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Email sent to {data.customerEmail}
              </div>
            ) : (
              <button
                onClick={handleSendEmail}
                disabled={sendInvoiceEmail.isPending}
                className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
                  {sendInvoiceEmail.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin text-navy/70" />
                  ) : (
                    <Mail className="h-4 w-4 text-navy/70" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-navy">Send via Email</p>
                  <p className="text-xs text-navy/70">{data.customerEmail}</p>
                </div>
              </button>
            ))}

          {/* SMS */}
          {phone && (
            <a
              href={`sms:${phone}?body=${invoiceMsg}`}
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
                <Phone className="h-4 w-4 text-navy/70" />
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Send via Text</p>
                <p className="text-xs text-navy/70">{phone}</p>
              </div>
            </a>
          )}

          {/* Download PDF */}
          <button
            onClick={handleDownload}
            disabled={pdfLoading}
            className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
              {pdfLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-navy/70" />
              ) : (
                <Download className="h-4 w-4 text-navy/70" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-navy">Download PDF</p>
              <p className="text-xs text-navy/70">Save a copy to your device</p>
            </div>
          </button>

          {/* Print PDF */}
          <button
            onClick={handlePrint}
            disabled={printLoading}
            className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
              {printLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-navy/70" />
              ) : (
                <Printer className="h-4 w-4 text-navy/70" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-navy">Print</p>
              <p className="text-xs text-navy/70">Open the print dialog</p>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-border px-5 py-3">
          <button
            onClick={onClose}
            className="w-full rounded-lg px-4 py-2 text-sm text-navy/70 hover:text-navy hover:bg-surface-raised transition-colors"
          >
            Skip — I&apos;ll send it later
          </button>
        </div>
      </div>
    </div>
  );
}
