"use client";

import { CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { PriorScanSummary } from "@/lib/api/vendor-bills";
import { fmtDate } from "@/lib/formatting";
import { fmt } from "./helpers";

/**
 * Says what happened the last time these exact bytes were uploaded. Never a
 * failure: either the work is already done (a bill exists — open it instead of
 * paying twice in stock and cash), or an abandoned review just came back
 * whole, off the archive, with no second AI call.
 */
export function PriorScanBanner({
  prior,
  disabled,
  onSkip,
}: {
  prior: PriorScanSummary;
  disabled?: boolean;
  /** Drop this pre-existing invoice from the batch — only offered when the
   *  prior scan was POSTED (the green "restored" variant isn't a duplicate). */
  onSkip?: () => void;
}) {
  const recorded = prior.status === "POSTED" && !!prior.vendorBillId;
  // fmtDate answers with an em-dash for anything unparseable; a missing
  // timestamp should drop the clause entirely rather than read "on —".
  const at = prior.scannedAt ? new Date(prior.scannedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? fmtDate(prior.scannedAt) : null;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3",
        recorded ? "border-amber-200 bg-amber-50" : "border-green-200 bg-green-50",
      )}
      data-testid="prior-scan-banner"
    >
      {recorded ? (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs", recorded ? "text-amber-800" : "text-green-700")}>
          {recorded ? (
            <>
              <span className="font-semibold">
                You already scanned this — recorded as {prior.billNumber ?? "a vendor bill"}
                {when ? ` on ${when}` : ""}
                {prior.total != null ? `, ${fmt(prior.total)}` : ""}.
              </span>{" "}
              Open that bill instead of recording it a second time.
            </>
          ) : (
            <>
              <span className="font-semibold">
                Picking up where you left off — this document was scanned
                {when ? ` on ${when}` : " earlier"} and never finished.
              </span>{" "}
              Everything below is the saved extraction, restored without re-reading the invoice.
            </>
          )}
        </p>
        {recorded && prior.vendorBillId && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={`/vendor-bills/${prior.vendorBillId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open {prior.billNumber ?? "existing bill"}
            </a>
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                disabled={disabled}
                data-testid="duplicate-skip"
                className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Skip this invoice
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
