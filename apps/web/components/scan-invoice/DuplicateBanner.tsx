"use client";

import { Loader2, AlertCircle, ExternalLink, Undo2 } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { DuplicateVendorBillInfo } from "@/lib/api/vendor-bills";
import { fmtCalendarDate } from "@/lib/formatting";
import { fmt } from "./helpers";

/**
 * Warns that this supplier invoice is already in the system. Two shapes,
 * because the recovery differs: a DRAFT match is resumable (finish that bill),
 * an already-received match is not (a second one would double stock).
 */
export function DuplicateBanner({
  duplicate,
  pending,
  allowDuplicate,
  disabled,
  onAllow,
  onUndo,
  onSkip,
}: {
  duplicate: DuplicateVendorBillInfo | null;
  pending: boolean;
  allowDuplicate: boolean;
  disabled?: boolean;
  onAllow: () => void;
  onUndo: () => void;
  /** Drop this pre-existing invoice from the batch (status → "skipped"). */
  onSkip: () => void;
}) {
  if (!duplicate) {
    return pending ? (
      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-navy/60">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking whether this invoice is already recorded…
      </p>
    ) : null;
  }

  if (allowDuplicate) {
    return (
      <div
        className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-white px-2.5 py-2"
        data-testid="duplicate-override"
      >
        <p className="text-xs text-navy/70">
          Recording a second bill anyway — {duplicate.billNumber} already exists.
        </p>
        <button
          type="button"
          onClick={onUndo}
          disabled={disabled}
          className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      </div>
    );
  }

  const resumable = duplicate.resumable;
  const seenOn = duplicate.receivedDate ?? duplicate.billDate;
  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2 rounded-lg border p-2.5",
        resumable ? "border-amber-200 bg-amber-50" : "border-danger/30 bg-danger-bg",
      )}
      data-testid="duplicate-banner"
    >
      <AlertCircle
        className={cn("mt-0.5 h-4 w-4 shrink-0", resumable ? "text-amber-600" : "text-danger")}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs", resumable ? "text-amber-800" : "text-danger")}>
          {resumable ? (
            <>
              <span className="font-semibold">
                A draft bill for this invoice already exists — {duplicate.billNumber},{" "}
                {fmt(duplicate.totalOwed)}.
              </span>{" "}
              Finish that one instead of creating a second bill.
            </>
          ) : (
            <>
              <span className="font-semibold">
                Already imported as {duplicate.billNumber}
                {seenOn ? ` on ${fmtCalendarDate(seenOn)}` : ""}.
              </span>{" "}
              Creating it again would double stock and the amount owed.
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            href={`/vendor-bills/${duplicate.billId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View existing bill
          </a>
          <button
            type="button"
            onClick={onSkip}
            disabled={disabled}
            data-testid="duplicate-skip"
            className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Skip this invoice
          </button>
          <button
            type="button"
            onClick={onAllow}
            disabled={disabled}
            className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create anyway
          </button>
        </div>
      </div>
    </div>
  );
}
