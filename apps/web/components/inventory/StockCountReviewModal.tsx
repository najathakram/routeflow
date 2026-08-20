"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, RefreshCw, Trash2, X } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import { DecimalInput } from "@/components/MoneyInput";
import { fmt } from "@/lib/formatting";
import { roundMoney } from "@/lib/pricing";
import {
  computeCountedAfter,
  computeQtyVariance,
  type StockCountLocalRow,
} from "@/lib/api/stock-count";

const DECIMAL_UNITS = ["kg", "g", "liter", "litre", "l", "oz", "lb", "pound", "ml"];
function isDecimalUnit(unit: string) {
  return DECIMAL_UNITS.includes(unit.toLowerCase());
}

interface StockCountReviewModalProps {
  isOpen: boolean;
  rows: StockCountLocalRow[];
  notes: string;
  onChangeNotes: (notes: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  isSubmitting: boolean;
  /** Number of edits queued for the server but not yet confirmed saved. The
   *  commit button stays disabled while this is non-zero — a count can only be
   *  committed from what the server actually has. */
  unsavedCount: number;
  /** True after a background autosave attempt failed and is waiting to retry. */
  syncError: boolean;
  onRetrySync: () => void;
  onChangeQty: (productId: string, qty: number) => void;
  onChangeUnitCost: (productId: string, unitCost: number | null) => void;
  onRemoveRow: (productId: string) => void;
  /** Active products with no line in this session at all — "uncounted". */
  uncountedCount: number;
}

export function StockCountReviewModal({
  isOpen,
  rows,
  notes,
  onChangeNotes,
  onClose,
  onConfirm,
  isSubmitting,
  unsavedCount,
  syncError,
  onRetrySync,
  onChangeQty,
  onChangeUnitCost,
  onRemoveRow,
  uncountedCount,
}: StockCountReviewModalProps) {
  const [showMatches, setShowMatches] = React.useState(false);

  if (!isOpen) return null;

  const previews = rows
    .map((row) => {
      const after = computeCountedAfter(row);
      const qtyVariance = computeQtyVariance(row);
      const dollarVariance = roundMoney(qtyVariance * (row.averageCost ?? 0));
      return { row, after, qtyVariance, dollarVariance };
    })
    .sort((a, b) => Math.abs(b.dollarVariance) - Math.abs(a.dollarVariance));

  const changed = previews.filter((p) => p.qtyVariance !== 0);
  const matched = previews.filter((p) => p.qtyVariance === 0);

  const posSum = roundMoney(
    changed.reduce((s, p) => (p.dollarVariance > 0 ? s + p.dollarVariance : s), 0),
  );
  const negSum = roundMoney(
    changed.reduce((s, p) => (p.dollarVariance < 0 ? s + p.dollarVariance : s), 0),
  );

  const commitSummary =
    `Adjust ${changed.length.toLocaleString("en-US")} product${changed.length === 1 ? "" : "s"} ` +
    `(+${fmt(posSum)} / −${fmt(Math.abs(negSum))} at avg cost); ` +
    `${uncountedCount.toLocaleString("en-US")} uncounted product${uncountedCount === 1 ? "" : "s"} unchanged.`;

  const canCommit = changed.length > 0 && unsavedCount === 0 && !isSubmitting;

  const renderRow = ({
    row,
    after,
    qtyVariance,
    dollarVariance,
  }: {
    row: StockCountLocalRow;
    after: number;
    qtyVariance: number;
    dollarVariance: number;
  }) => (
    <tr key={row.productId} className="border-b border-surface-border/50 align-top">
      <td className="py-2 pr-2">
        <div className="font-medium text-navy">{row.name}</div>
        <div className="text-xs text-navy/70">
          {row.sku ? `${row.sku} · ` : ""}
          {row.unit}
        </div>
      </td>
      <td className="py-2 pr-2 text-right text-navy/70">{row.expectedQty}</td>
      <td className="py-2 pr-2">
        <DecimalInput
          value={row.countedQty}
          onChange={(v) => onChangeQty(row.productId, v ?? 0)}
          decimals={isDecimalUnit(row.unit) ? 3 : 0}
          min={0}
          max={9999999.999}
          className="w-20 px-2 py-1 text-right"
        />
      </td>
      <td className="py-2 pr-2 text-right font-medium text-navy">{after}</td>
      <td
        className={cn(
          "py-2 pr-2 text-right font-medium",
          qtyVariance > 0 ? "text-success" : qtyVariance < 0 ? "text-danger" : "text-navy/70",
        )}
      >
        {qtyVariance > 0 ? "+" : ""}
        {qtyVariance}
      </td>
      <td
        className={cn(
          "py-2 pr-2 text-right font-medium whitespace-nowrap",
          dollarVariance > 0 ? "text-success" : dollarVariance < 0 ? "text-danger" : "text-navy/70",
        )}
      >
        {dollarVariance > 0 ? "+" : dollarVariance < 0 ? "−" : ""}
        {fmt(Math.abs(dollarVariance))}
      </td>
      <td className="py-2 pr-2">
        <div>
          <DecimalInput
            value={row.unitCostOverride ?? null}
            onChange={(v) => onChangeUnitCost(row.productId, v)}
            decimals={4}
            min={0}
            max={1_000_000}
            placeholder={row.averageCost != null ? row.averageCost.toFixed(4) : "0.0000"}
            className="w-24 px-2 py-1 text-right"
          />
          <p className="mt-0.5 text-[10px] leading-tight text-navy/60">
            Sets cost basis, not just count
          </p>
        </div>
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={() => onRemoveRow(row.productId)}
          className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-danger"
          title="Remove from this count"
        >
          <Trash2 size={16} />
        </button>
      </td>
    </tr>
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Review stock count</h2>
            <p className="mt-0.5 text-xs text-navy/70">
              {changed.length} change{changed.length === 1 ? "" : "es"}
              {matched.length > 0 &&
                ` · ${matched.length} match${matched.length === 1 ? "" : "es"}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {unsavedCount > 0 && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
                <RefreshCw size={12} className="animate-spin" />
                Saving {unsavedCount} change{unsavedCount === 1 ? "" : "s"}…
              </span>
            )}
            {unsavedCount === 0 && syncError && (
              <Button
                size="sm"
                variant="secondary"
                onClick={onRetrySync}
                leftIcon={<RefreshCw size={14} />}
              >
                Retry sync
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border text-left text-xs uppercase tracking-wide text-navy/70">
                <th className="py-2 pr-2 font-medium">Product</th>
                <th className="py-2 pr-2 text-right font-medium">Expected</th>
                <th className="py-2 pr-2 text-left font-medium">Counted</th>
                <th className="py-2 pr-2 text-right font-medium">After</th>
                <th className="py-2 pr-2 text-right font-medium">Variance</th>
                <th className="py-2 pr-2 text-right font-medium">$ at avg cost</th>
                <th className="py-2 pr-2 text-left font-medium">Unit cost</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {changed.map(renderRow)}
              {matched.length > 0 && (
                <>
                  <tr>
                    <td colSpan={8} className="pt-3 pb-1">
                      <button
                        type="button"
                        onClick={() => setShowMatches((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-navy/70 hover:text-navy"
                      >
                        {showMatches ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {matched.length} line{matched.length === 1 ? "" : "s"} match — no change
                      </button>
                    </td>
                  </tr>
                  {showMatches && matched.map(renderRow)}
                </>
              )}
              {previews.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-navy/70">
                    Nothing counted yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-navy">
              Notes <span className="font-normal text-navy/70">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => onChangeNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Weekly shelf count — back room only"
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-[11px] text-navy/70">
              Stored on each stock movement created by this commit.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-border px-6 py-4">
          <p className="mb-3 text-sm text-navy">{commitSummary}</p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="button" onClick={onConfirm} loading={isSubmitting} disabled={!canCommit}>
              Commit {changed.length} change{changed.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
