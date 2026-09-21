"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { InvoiceStatus, InvoiceGroup } from "./types";

const STATUS_DOT: Record<InvoiceStatus, { cls: string; label: string }> = {
  scanning: { cls: "bg-navy/30 animate-pulse", label: "Scanning" },
  scanned: { cls: "bg-brand-500", label: "Ready to review" },
  failed: { cls: "bg-danger", label: "Scan failed" },
  created: { cls: "bg-success", label: "Created" },
  skipped: { cls: "bg-navy/20", label: "Skipped — already recorded" },
};

/**
 * Batch navigator: prominent ◀ ▶ buttons to move between the scanned
 * invoices (one per PDF). Switching moves BOTH the preview panel and the
 * whole review form. Status dots jump straight to an invoice.
 */
export function InvoiceNavigator({
  invoices,
  activeIndex,
  disabled,
  onNavigate,
  skippableDupCount = 0,
  onSkipAll,
}: {
  invoices: InvoiceGroup[];
  activeIndex: number;
  disabled?: boolean;
  onNavigate: (index: number) => void;
  /** Reviewable invoices currently matching something already in the system. */
  skippableDupCount?: number;
  /** Batch affordance: drop them all without paging through each one. */
  onSkipAll?: () => void;
}) {
  const active = invoices[activeIndex];
  const label = active
    ? (active.scanResult?.supplier ??
      (active.status === "scanning"
        ? "Scanning…"
        : active.status === "failed"
          ? "Scan failed"
          : (active.pagePreviews[0]?.name ?? "Invoice")))
    : "";
  // Same supplier invoice # appearing twice in one batch = likely the same
  // document uploaded twice.
  const norm = (n: string) => n.toUpperCase().replace(/\s+/g, "");
  const numberCounts = new Map<string, number>();
  for (const inv of invoices) {
    if (!inv.invoiceNumber) continue;
    const key = norm(inv.invoiceNumber);
    numberCounts.set(key, (numberCounts.get(key) ?? 0) + 1);
  }
  const isDuplicate =
    !!active?.invoiceNumber && (numberCounts.get(norm(active.invoiceNumber)) ?? 0) > 1;
  // Cross-session duplicate: matched against a bill recorded before this batch.
  const existingBill =
    active && active.createMode !== "expense" && !active.allowDuplicate ? active.duplicate : null;
  // Byte-identical to a document already in the archive. Suppressed when the
  // duplicate marker is already saying the same thing about the same bill.
  const prior = existingBill ? null : (active?.scanResult?.priorScan ?? null);
  const priorRecorded = !!prior && prior.status === "POSTED" && !!prior.vendorBillId;

  return (
    <div className="flex items-center gap-3 border-b border-surface-border bg-surface-raised px-4 py-2">
      <button
        type="button"
        onClick={() => onNavigate(activeIndex - 1)}
        disabled={disabled || activeIndex === 0}
        className="flex items-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-semibold text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
        title="Previous invoice"
        data-testid="invoice-nav-prev"
      >
        <ChevronLeft className="h-4 w-4" />
        Prev
      </button>
      <div className="min-w-0 flex-1 text-center">
        <p className="text-xs font-semibold text-navy">
          Invoice {activeIndex + 1} of {invoices.length}
          {active?.invoiceNumber ? ` · #${active.invoiceNumber}` : ""}
        </p>
        <p className="truncate text-[11px] text-navy/60" title={label}>
          {label}
          {/* "Skipped" outranks every other marker — the decision is made. */}
          {active?.status === "skipped" ? (
            <span className="font-medium text-navy/50"> — skipped (already recorded)</span>
          ) : (
            <>
              {isDuplicate && (
                <span className="font-medium text-amber-600">
                  {" "}
                  — same invoice # as another file in this batch
                </span>
              )}
              {existingBill && (
                <span
                  className={cn(
                    "font-medium",
                    existingBill.resumable ? "text-amber-600" : "text-danger",
                  )}
                >
                  {" "}
                  — already {existingBill.resumable ? "saved as draft" : "imported as"}{" "}
                  {existingBill.billNumber}
                </span>
              )}
              {prior && (
                <span
                  className={cn("font-medium", priorRecorded ? "text-amber-600" : "text-green-700")}
                >
                  {" "}
                  —{" "}
                  {priorRecorded
                    ? `already recorded as ${prior.billNumber ?? "a bill"}`
                    : "restored from an earlier scan"}
                </span>
              )}
            </>
          )}
        </p>
        {skippableDupCount > 1 && onSkipAll && (
          <button
            type="button"
            onClick={onSkipAll}
            disabled={disabled}
            data-testid="skip-all-duplicates"
            className="mt-0.5 text-[11px] font-medium text-brand-600 transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {skippableDupCount} already recorded · Skip them
          </button>
        )}
        <div className="mt-1 flex items-center justify-center gap-1.5">
          {invoices.map((inv, i) => (
            <button
              key={inv.id}
              type="button"
              onClick={() => onNavigate(i)}
              disabled={disabled}
              className={cn(
                "h-2.5 w-2.5 rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-40",
                STATUS_DOT[inv.status].cls,
                i === activeIndex && "ring-2 ring-brand-300 ring-offset-1",
              )}
              title={`Invoice ${i + 1}: ${STATUS_DOT[inv.status].label}`}
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onNavigate(activeIndex + 1)}
        disabled={disabled || activeIndex === invoices.length - 1}
        className="flex items-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-semibold text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
        title="Next invoice"
        data-testid="invoice-nav-next"
      >
        Next
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
