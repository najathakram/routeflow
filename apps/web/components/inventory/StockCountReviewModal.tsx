"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import type { StockCountRow } from "@/lib/stock-count-storage";

interface StockCountReviewModalProps {
  isOpen: boolean;
  rows: StockCountRow[];
  notes: string;
  onChangeNotes: (notes: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  isSubmitting: boolean;
}

export function StockCountReviewModal({
  isOpen,
  rows,
  notes,
  onChangeNotes,
  onClose,
  onConfirm,
  isSubmitting,
}: StockCountReviewModalProps) {
  if (!isOpen) return null;

  const previews = rows.map((r) => {
    const after =
      r.mode === "REPLACE" ? r.scannedQty : r.currentStockSnapshot + r.scannedQty;
    const delta = after - r.currentStockSnapshot;
    return { row: r, after, delta };
  });

  const totalDelta = previews.reduce((sum, p) => sum + p.delta, 0);
  const nonZero = previews.filter((p) => p.delta !== 0).length;
  const skipped = previews.length - nonZero;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Review stock count</h2>
            <p className="mt-0.5 text-xs text-navy/50">
              {nonZero} change{nonZero === 1 ? "" : "s"}
              {skipped > 0 && ` · ${skipped} no-op${skipped === 1 ? "" : "s"}`} · ΣΔ ={" "}
              {totalDelta > 0 ? "+" : ""}
              {totalDelta}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border text-left text-xs uppercase tracking-wide text-navy/50">
                <th className="py-2">Product</th>
                <th className="py-2 text-right">Before</th>
                <th className="py-2 text-right">After</th>
                <th className="py-2 text-right">Δ</th>
                <th className="py-2 text-right">Mode</th>
              </tr>
            </thead>
            <tbody>
              {previews.map(({ row, after, delta }) => (
                <tr key={row.rowId} className="border-b border-surface-border/50">
                  <td className="py-2">
                    <div className="font-medium text-navy">{row.name}</div>
                    <div className="text-xs text-navy/50">
                      {row.sku ? `${row.sku} · ` : ""}
                      {row.unit}
                    </div>
                  </td>
                  <td className="py-2 text-right text-navy/70">
                    {row.currentStockSnapshot}
                  </td>
                  <td className="py-2 text-right font-medium text-navy">{after}</td>
                  <td
                    className={cn(
                      "py-2 text-right font-medium",
                      delta > 0
                        ? "text-success"
                        : delta < 0
                          ? "text-danger"
                          : "text-navy/40",
                    )}
                  >
                    {delta > 0 ? "+" : ""}
                    {delta}
                  </td>
                  <td className="py-2 text-right text-xs text-navy/60">{row.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-navy">
              Notes <span className="font-normal text-navy/40">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => onChangeNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Weekly shelf count — back room only"
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-[11px] text-navy/40">
              Stored on each stock movement created by this commit.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" type="button" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            loading={isSubmitting}
            disabled={nonZero === 0}
          >
            Commit {nonZero} change{nonZero === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </div>
  );
}
