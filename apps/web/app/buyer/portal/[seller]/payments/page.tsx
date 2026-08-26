"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Wallet,
  Landmark,
  CreditCard,
  Clock,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  Info,
  FileText,
  Download,
} from "lucide-react";
import { Badge, useToast } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerPayments,
  useBuyerStatement,
  useBuyerRemittance,
  useBuyerStatementMonths,
  fetchStatementPdfUrl,
} from "@/lib/api/buyer";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { fetchPdfBlob } from "@/lib/fetch-pdf-blob";
import { checkBadgeFor } from "@/lib/check-badge";
import { MakePaymentPanel } from "./_components/MakePaymentPanel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatPaymentMethod(method: string): string {
  return method
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "YYYY-MM" → "July 2026", UTC-safe (never shifts across a local-timezone day boundary). */
function monthLabel(bucket: string): string {
  const [y, m] = bucket.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">{label}</p>
          <p className="mt-1.5 text-2xl font-bold text-navy">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-navy/70">{sub}</p>}
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

// ─── How-to-pay field ─────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value?: string }) {
  if (!value || !value.trim()) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">{label}</p>
      <p className="mt-0.5 whitespace-pre-line text-sm text-navy">{value}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function BuyerPaymentsPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  // Card payments settle by webhook — `processing` must never claim success.
  const paymentFlag = searchParams.get("payment");
  const paymentBanner =
    paymentFlag === "processing"
      ? {
          tone: "info" as const,
          text: "Your card payment is confirming — your balance updates in a moment.",
        }
      : paymentFlag === "cancelled"
        ? { tone: "neutral" as const, text: "Payment cancelled." }
        : null;

  // Seeded from the invoice-detail "Pay this invoice" link (?amount=<balanceDue>).
  const amountParam = searchParams.get("amount");
  const parsedAmount = amountParam ? Number(amountParam) : NaN;
  const defaultAmount =
    Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : undefined;

  const [page, setPage] = React.useState(1);
  const { data: payments, isLoading, isError } = useBuyerPayments({ page, limit: 20 });

  // P5-14: the wallet tile and how-to-pay card are separate, independent
  // fetches — never gate this page's own load/error state on them (mirrors
  // finances/page.tsx). The wallet value is the SAME cache entry Finances
  // reads (useBuyerStatement().availableCredit) — never recomputed here.
  const { data: statement } = useBuyerStatement();
  const { data: remittance } = useBuyerRemittance();
  const { toast } = useToast();

  const activeCredits = (statement?.transactions ?? []).filter(
    (t) => t.type === "CREDIT_NOTE" && t.runningBalance > 0.001,
  );

  // P5-15: monthly statement PDF download.
  const { data: statementMonths } = useBuyerStatementMonths();
  const months = statementMonths?.months ?? [];
  const [statementMonth, setStatementMonth] = React.useState<string>("");
  const [statementDownloading, setStatementDownloading] = React.useState(false);

  React.useEffect(() => {
    if (!statementMonth && months.length > 0) {
      setStatementMonth(months[0]);
    }
  }, [months, statementMonth]);

  /** Mirrors invoice detail's handleDownloadPdf EXACTLY: fetch the presigned
   *  URL, pull the bytes through fetchPdfBlob (auth'd vs bare by origin), then
   *  a programmatic <a download> — never <a href>/window.open. */
  async function handleDownloadStatement() {
    if (!statementMonth) return;
    setStatementDownloading(true);
    try {
      const url = await fetchStatementPdfUrl(statementMonth);
      const blob = await fetchPdfBlob(url, buyerApiClient);
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `statement-${statementMonth}.pdf`;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast({
        title: "Couldn't download statement",
        description:
          status === 401 ? "Please refresh the page and try again." : "Try again in a moment.",
        variant: "error",
      });
    } finally {
      setStatementDownloading(false);
    }
  }

  // Validate slug matches active seller.
  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  // Redirect if no active seller after auth loads.
  React.useEffect(() => {
    if (!authLoading && !activeSeller) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, router]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  const rows = payments?.data ?? [];
  const meta = payments?.meta;
  const hasRemittance =
    !!remittance && Object.values(remittance).some((v) => v && String(v).trim());

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-navy">Payments</h1>
        {activeSeller?.customer && (
          <p className="text-sm text-navy/70 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
      </div>

      {/* Redirect banner from the Stripe Checkout return (?payment=processing|cancelled) */}
      {paymentBanner && (
        <div
          className={
            paymentBanner.tone === "info"
              ? "flex items-center gap-2 rounded-lg border border-info/30 bg-info-bg/60 px-4 py-3 text-sm text-navy"
              : "flex items-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm text-navy/70"
          }
        >
          <Info className="h-4 w-4 flex-shrink-0" />
          {paymentBanner.text}
        </div>
      )}

      {/* Make a payment — the primary action, first block on the page */}
      <MakePaymentPanel defaultAmount={defaultAmount} />

      {/* Wallet row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard
          icon={Wallet}
          label="Store Credit"
          value={fmt(statement?.availableCredit ?? 0)}
          sub={activeCredits.length > 0 ? `${activeCredits.length} active` : "None available"}
          color="bg-buyer-50 text-buyer-600"
        />
        <StatCard
          icon={Clock}
          label="Outstanding"
          value={fmt(statement?.outstandingAmount ?? 0)}
          color="bg-warning-bg text-warning"
        />
      </div>

      {/* Monthly statement */}
      <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="h-4 w-4 text-buyer-500" />
          <h2 className="text-sm font-semibold text-navy">Monthly statement</h2>
        </div>
        {months.length === 0 ? (
          <p className="py-4 text-center text-xs text-navy/70">
            Statements become available after your first invoice.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={statementMonth}
              onChange={(e) => setStatementMonth(e.target.value)}
              className="rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-buyer-500"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleDownloadStatement()}
              disabled={!statementMonth || statementDownloading}
              className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-navy transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
            >
              {statementDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Download
            </button>
          </div>
        )}
      </div>

      {/* Payments table */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-navy">Payment History</h2>
        {isError ? (
          <div className="flex items-center gap-2 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            Failed to load payments.
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
            <CreditCard className="mx-auto mb-4 h-12 w-12 text-navy/20" />
            <h3 className="text-lg font-semibold text-navy mb-2">No payments yet</h3>
            <p className="text-sm text-navy/70">
              Payments recorded against your invoices will appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-surface-border bg-white shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-surface-border bg-surface-raised">
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Date
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Invoice #
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Method
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Status
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {rows.map((p) => {
                      const badge = checkBadgeFor(p);
                      const voided = p.status === "VOID";
                      return (
                        <tr key={p.id} className="hover:bg-surface-raised/50">
                          <td className="px-4 py-3 text-sm text-navy/70">{fmtDate(p.paidAt)}</td>
                          <td className="px-4 py-3 text-sm font-medium">
                            <Link
                              href={`/buyer/portal/${sellerSlug}/invoices/${p.invoiceId}`}
                              className="text-buyer-600 hover:underline"
                            >
                              {p.invoiceNumber}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-sm text-navy/70">
                            {formatPaymentMethod(p.method)}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {badge && (
                              <div className="flex flex-col items-start gap-0.5">
                                <Badge variant={badge.variant}>{badge.label}</Badge>
                                {p.checkStatus === "BOUNCED" && p.nsfFeeAmount != null && (
                                  <span className="text-[11px] font-medium text-danger">
                                    + {fmt(p.nsfFeeAmount)} NSF fee
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td
                            className={`px-4 py-3 text-right text-sm font-medium ${
                              voided ? "text-danger line-through" : "text-success"
                            }`}
                          >
                            {fmt(p.amount)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            {meta && meta.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-navy/70">
                  Showing {(meta.page - 1) * meta.limit + 1} to{" "}
                  {Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => p - 1)}
                    disabled={page === 1}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-navy">
                    Page {meta.page} of {meta.totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page === meta.totalPages}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* How-to-pay */}
      <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Landmark className="h-4 w-4 text-buyer-500" />
          <h2 className="text-sm font-semibold text-navy">
            How to pay {activeSeller?.tenant.name ?? "your seller"}
          </h2>
        </div>
        {!hasRemittance ? (
          <p className="py-8 text-center text-xs text-navy/70">
            This seller hasn&apos;t added payment instructions yet.
          </p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Pay to" value={remittance?.payToName} />
              <Field label="Bank" value={remittance?.bankName} />
              <Field label="Account name" value={remittance?.accountName} />
              <Field label="Account number" value={remittance?.accountNumber} />
              <Field label="Routing number" value={remittance?.routingNumber} />
            </div>
            <div className="space-y-4">
              <Field label="Mail checks to" value={remittance?.mailingAddress} />
              <Field label="Paying by check" value={remittance?.checkInstructions} />
              <Field label="ACH" value={remittance?.achInstructions} />
              <Field label="Wire" value={remittance?.wireInstructions} />
              <Field label="Notes" value={remittance?.notes} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Suspense wrapper required because the page (and MakePaymentPanel inside it)
// uses useSearchParams() — Next 14 fails the production build without a
// boundary above the call. Same pattern as buyer/portal/page.tsx.
export default function BuyerPaymentsPage() {
  return (
    <React.Suspense fallback={null}>
      <BuyerPaymentsPageInner />
    </React.Suspense>
  );
}
