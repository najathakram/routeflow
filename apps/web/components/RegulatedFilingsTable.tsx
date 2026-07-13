"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Badge, useToast } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import { fetchRegulatedFilingUrl, type RegulatedFiling } from "@/lib/api/tracked-categories";

interface Props {
  filings: RegulatedFiling[];
  /** Show the "Category" column (index view). Omit for a single-section view. */
  showCategory?: boolean;
  /** Resolve a section id → display name (required when showCategory). */
  categoryName?: (id: string) => string;
  /** Optional copy for the empty state. */
  emptyHint?: React.ReactNode;
}

/**
 * Shared filings table for the regulated surfaces — the /compliance index (all
 * sections, with a Category column) and the per-section dashboard (one section).
 * Only CSV is offered; PDF generation hasn't shipped (pdfKey is always null).
 */
export function RegulatedFilingsTable({
  filings,
  showCategory = false,
  categoryName,
  emptyHint,
}: Props) {
  const { toast } = useToast();

  const openFilingUrl = async (id: string) => {
    const url = await fetchRegulatedFilingUrl(id, "csv");
    window.open(url, "_blank", "noopener");
  };

  if (filings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-8 text-center text-sm text-navy/70">
        {emptyHint ?? (
          <>
            No filings prepared yet. Use{" "}
            <span className="font-medium text-navy">Prepare filing</span> to generate one for the
            last completed period.
          </>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border text-left text-xs text-navy/60">
            <th className="py-2 pr-3 font-medium">Period</th>
            {showCategory && <th className="py-2 pr-3 font-medium">Category</th>}
            <th className="py-2 pr-3 text-right font-medium">Net sales</th>
            <th className="py-2 pr-3 text-right font-medium">Tax</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {filings.map((f) => (
            <tr key={f.id} className="border-b border-surface-border/60 last:border-0">
              <td className="py-2 pr-3 font-medium text-navy">{f.periodKey}</td>
              {showCategory && (
                <td className="py-2 pr-3 text-navy/80">
                  {categoryName?.(f.trackedCategoryId) ?? "—"}
                </td>
              )}
              <td className="py-2 pr-3 text-right tabular-nums text-navy">
                {fmt(Number(f.totalNetSales))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-navy">
                {fmt(Number(f.totalCategoryTax))}
              </td>
              <td className="py-2 pr-3">
                <Badge
                  variant={f.status === "GENERATED" ? "success" : "warning"}
                  label={f.status === "GENERATED" ? "Generated" : "Failed"}
                />
              </td>
              <td className="py-2 text-right">
                {f.csvKey && (
                  <button
                    type="button"
                    onClick={() =>
                      openFilingUrl(f.id).catch(() =>
                        toast({ title: "Failed to open CSV", variant: "error" }),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-surface-raised"
                  >
                    <Download className="h-3.5 w-3.5" /> CSV
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
