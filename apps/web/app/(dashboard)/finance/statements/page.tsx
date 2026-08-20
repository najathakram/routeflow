"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Upload,
  Loader2,
  Sparkles,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";
import { PageHeader, Button, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  scanStatement,
  getStatementAiError,
  useSupplierStatementScan,
  type StatementScanResult,
  type StatementAiError,
  type ApplyStatementResult,
} from "@/lib/api/supplier-statements";
import {
  StatementReviewGrid,
  type AppliedRowSummary,
  type ImpliedPaidBill,
} from "@/components/StatementReviewGrid";
import { fmt, fmtDate } from "@/lib/formatting";

type WizardStep = "upload" | "processing" | "review" | "applied";

const ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf,.heic,.heif";

interface AppliedState {
  result: ApplyStatementResult;
  confirmed: AppliedRowSummary[];
  impliedPaid: ImpliedPaidBill[] | null;
}

/** One line of "what the apply did" — from the in-session apply, or read back
 *  off the scan's payment group when the statement is reopened later. */
interface AppliedRow {
  key: string;
  billId: string | null;
  billNumber: string;
  amount: number;
  impliedPaid: boolean;
}

/**
 * PR-F WP4 — upload/capture → processing → one review screen. Follows
 * `ScanInvoiceModal`'s wizard shape (upload/processing/review), but as a
 * full page rather than a modal: a dense reconciliation grid earns the
 * whole screen, and the AI only ever READS the statement here — every
 * money-moving decision happens on the review grid via an explicit Apply.
 * `?scanId=` makes a scan revisitable (bookmark, reload mid-review, or an
 * already-applied statement reopened for its summary).
 */
function StatementsPageInner() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Supplier Statements");
  }, [setTitle]);

  const router = useRouter();
  const searchParams = useSearchParams();

  // Captured once on mount — a fresh upload clears it (see runScan) so the
  // revisit path and the fresh-scan path never intermix.
  const [revisitId, setRevisitId] = React.useState<string | null>(() => searchParams.get("scanId"));
  const [step, setStep] = React.useState<WizardStep>(revisitId ? "processing" : "upload");
  const [files, setFiles] = React.useState<File[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [result, setResult] = React.useState<StatementScanResult | null>(null);
  const [scanError, setScanError] = React.useState<StatementAiError | null>(null);
  const [applied, setApplied] = React.useState<AppliedState | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // The scan the in-session `applied` summary belongs to. Applying invalidates
  // ["supplier-statements"], which refetches the query below and hands the
  // effect a NEW data reference for the SAME scan — clearing on that would
  // wipe the just-rendered breakdown of what the apply did a frame after it
  // appeared. Reset only when the scan itself changes.
  const loadedScanId = React.useRef<string | null>(null);

  const existing = useSupplierStatementScan(revisitId);
  React.useEffect(() => {
    if (!existing.data) return;
    setResult(existing.data);
    if (loadedScanId.current !== existing.data.scanId) {
      loadedScanId.current = existing.data.scanId;
      setApplied(null);
    }
    setStep(existing.data.status === "APPLIED" ? "applied" : "review");
  }, [existing.data]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const runScan = async (toScan: File[]) => {
    setRevisitId(null);
    loadedScanId.current = null;
    setStep("processing");
    setScanError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await scanStatement(toScan, controller.signal);
      if (controller.signal.aborted) return;
      setResult(res);
      setApplied(null);
      // scanId can be null if the row failed to persist — nothing to
      // bookmark or apply in that case, so leave the URL alone.
      if (res.scanId) router.replace(`/finance/statements?scanId=${res.scanId}`);
      setStep(res.status === "APPLIED" ? "applied" : "review");
    } catch (err) {
      if (controller.signal.aborted) return;
      setScanError(getStatementAiError(err));
    }
  };

  const handleFiles = (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (arr.length === 0) return;
    setFiles(arr);
    void runScan(arr);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };

  const handleScanAnother = () => {
    abortRef.current?.abort();
    setFiles([]);
    setResult(null);
    setScanError(null);
    setApplied(null);
    setRevisitId(null);
    loadedScanId.current = null;
    router.replace("/finance/statements");
    setStep("upload");
  };

  const isApiKeyError = scanError?.code === "AI_KEY_INVALID";
  const isUnavailable = scanError?.code === "AI_UNAVAILABLE";

  // What the apply did, from whichever source has it: the in-session summary
  // straight after Apply, and otherwise the payments the server reads back off
  // the scan's own payment group — so a statement reopened days later shows
  // the same per-bill breakdown rather than a bare date.
  const appliedRows = React.useMemo<AppliedRow[]>(() => {
    if (applied) {
      return [
        ...applied.confirmed.map((c) => ({
          key: `confirmed-${c.billId}`,
          billId: c.billId,
          billNumber: c.billNumber,
          amount: c.amount,
          impliedPaid: false,
        })),
        ...(applied.impliedPaid ?? []).map((b) => ({
          key: `implied-${b.billId}`,
          billId: b.billId,
          billNumber: b.billNumber,
          amount: b.outstanding,
          impliedPaid: true,
        })),
      ];
    }
    return (result?.appliedPayments ?? []).map((p) => ({
      key: p.id,
      billId: p.billId,
      billNumber: p.billNumber ?? "—",
      amount: p.amount,
      impliedPaid: p.impliedPaid,
    }));
  }, [applied, result]);

  const impliedPaidCount = appliedRows.filter((r) => r.impliedPaid).length;
  const confirmedCount = appliedRows.length - impliedPaidCount;
  // The one handle that ties a whole apply together — and undoes it, by being
  // voided. Deep-link to it rather than to the supplier at large.
  const paymentGroupId = applied?.result.paymentGroupId ?? result?.appliedPaymentGroupId ?? null;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Supplier Statements"
        subtitle="Upload a statement, let Claude read it, and reconcile it against your bills — nothing moves money until you Apply."
      />

      {step === "upload" && (
        <Card>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed py-16 transition-colors",
              isDragging
                ? "border-brand-500 bg-brand-50"
                : "border-surface-border bg-surface-raised hover:border-brand-300 hover:bg-brand-50/50",
            )}
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-100">
              <Upload className="h-7 w-7 text-brand-500" />
            </div>
            <div className="text-center">
              <p className="font-medium text-navy">Drop a statement here</p>
              <p className="mt-1 text-sm text-navy/70">
                or click to browse — a PDF, or the photographed pages of one statement
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
          </div>
          <p className="mt-4 text-center text-xs text-navy/70">
            <Sparkles className="inline h-3 w-3" /> Powered by Claude AI — matching happens in code
            afterward, deterministically, never by asking the model to decide.
          </p>
        </Card>
      )}

      {step === "processing" && revisitId && existing.isLoading && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
            </div>
            <p className="font-semibold text-navy">Loading statement…</p>
          </div>
        </Card>
      )}

      {step === "processing" && revisitId && existing.isError && (
        <Card>
          <div className="flex flex-col items-center gap-4 py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-bg">
              <AlertCircle className="h-7 w-7 text-danger" />
            </div>
            <p className="font-semibold text-navy">Couldn&apos;t load this statement</p>
            <div className="flex gap-3">
              <Button onClick={() => void existing.refetch()}>Try again</Button>
              <Button variant="secondary" onClick={handleScanAnother}>
                Back to upload
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === "processing" && !revisitId && !scanError && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-navy">Reading statement…</p>
              <p className="mt-1 text-sm text-navy/70">
                Claude is extracting invoices, payments, and credits — matching happens
                deterministically once it&apos;s done.
              </p>
            </div>
          </div>
        </Card>
      )}

      {step === "processing" && !revisitId && scanError && (
        <Card>
          <div className="flex flex-col items-center gap-4 py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-bg">
              <AlertCircle className="h-7 w-7 text-danger" />
            </div>
            <div>
              <p className="font-semibold text-navy">
                {isApiKeyError
                  ? "Anthropic API key not configured"
                  : scanError.code === "AI_SCAN_REJECTED"
                    ? "Couldn't read this file as a statement"
                    : isUnavailable
                      ? "Claude is unavailable right now"
                      : scanError.code === "AI_PARSE_FAILED"
                        ? "Couldn't parse what Claude read"
                        : "Couldn't scan this statement"}
              </p>
              <p className="mt-1 max-w-md text-sm text-navy/70">{scanError.message}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              {isApiKeyError && (
                <Button href="/settings?tab=integrations" variant="secondary">
                  Go to Settings
                </Button>
              )}
              {isUnavailable && files.length > 0 && (
                <Button
                  onClick={() => void runScan(files)}
                  leftIcon={<RefreshCw className="h-4 w-4" />}
                >
                  Retry
                </Button>
              )}
              <Button variant="secondary" onClick={handleScanAnother}>
                Back to upload
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === "review" && result && (
        <StatementReviewGrid
          result={result}
          onApplied={(res, confirmed, impliedPaid) => {
            setApplied({ result: res, confirmed, impliedPaid });
            setStep("applied");
          }}
        />
      )}

      {step === "applied" && result && (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-success" />
            <h3 className="text-base font-semibold text-navy">Applied</h3>
          </div>
          {appliedRows.length > 0 ? (
            <>
              <p className="text-sm text-navy/70">
                {confirmedCount} payment(s) recorded under one payment group
                {impliedPaidCount > 0 && <> · {impliedPaidCount} older bill(s) marked paid</>}
                {applied && applied.result.excess > 0.001 && (
                  <> · {fmt(applied.result.excess)} left as account credit</>
                )}
                {!applied && result.appliedAt && <> · applied {fmtDate(result.appliedAt)}</>}.
              </p>
              <div className="mt-3 overflow-hidden rounded-lg border border-surface-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                    <tr>
                      <th className="px-3 py-2 text-left">Bill #</th>
                      <th className="px-3 py-2 text-right">Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {appliedRows.map((row) => (
                      <tr key={row.key}>
                        <td className="px-3 py-2">
                          {row.billId ? (
                            <Link
                              href={`/vendor-bills/${row.billId}`}
                              className="font-medium text-brand-600 hover:underline"
                            >
                              {row.billNumber}
                            </Link>
                          ) : (
                            <span className="font-medium text-navy">{row.billNumber}</span>
                          )}
                          {row.impliedPaid && (
                            <span className="ml-1 text-xs text-navy/50">(implied-paid)</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-navy">{fmt(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-navy/70">
              This statement was already applied
              {result.appliedAt ? ` on ${fmtDate(result.appliedAt)}` : ""}.
            </p>
          )}
          {result.supplierId && (
            <Link
              href={
                paymentGroupId
                  ? `/suppliers/${result.supplierId}?paymentGroup=${paymentGroupId}`
                  : `/suppliers/${result.supplierId}`
              }
              className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
            >
              {paymentGroupId
                ? "View this payment group on the supplier's statement →"
                : "View the supplier's statement →"}
            </Link>
          )}
          <div className="mt-6">
            <Button
              variant="secondary"
              onClick={handleScanAnother}
              leftIcon={<ArrowLeft className="h-4 w-4" />}
            >
              Scan another statement
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function StatementsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
        </div>
      }
    >
      <StatementsPageInner />
    </React.Suspense>
  );
}
