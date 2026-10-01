"use client";

import Link from "next/link";
import { Badge } from "@routeflow/ui/web";
import { unitsLabel } from "@/lib/stock-label";

/**
 * The product detail's "Stock & Cost" card. Not rendered for a FAMILY container (non-stocked, non-sellable):
 * the page owns that rule. Extracted from page.tsx, which is at its size-ratchet cap.
 */
export function ProductStockCostCard({
  product,
  stockStatus,
  currentStock,
  onSetCost,
}: {
  product: any;
  stockStatus: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  currentStock: number;
  onSetCost: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Stock &amp; Cost
        </h3>
        <button
          type="button"
          onClick={() => onSetCost()}
          className="text-xs font-medium text-brand-600 transition-colors hover:underline"
        >
          Set cost
        </button>
      </div>
      <div className="px-4">
        <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
          <span className="text-navy/70">Stock status</span>
          {stockStatus === "OUT_OF_STOCK" ? (
            <Badge variant="danger" label="Out of Stock" />
          ) : stockStatus === "LOW" ? (
            <Badge variant="warning" label="Low Stock" />
          ) : (
            <Badge variant="success" label="In Stock" />
          )}
        </div>
        <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
          <span className="text-navy/70">On hand</span>
          <span className="font-mono font-medium tabular-nums text-navy">
            {unitsLabel(currentStock, product.unitsPerBox, product.unit)}
          </span>
        </div>
        {!product.parentProductId && (product.variants?.length ?? 0) > 0 && (
          <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
            <span
              className="text-navy/70"
              title="Stock on this generic not yet attributed to a variant"
            >
              Unassigned stock
            </span>
            <span className="font-mono font-medium tabular-nums text-navy">
              {unitsLabel(currentStock, product.unitsPerBox, product.unit)}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
          <span className="text-navy/70">Waitlist</span>
          <span
            className={
              (product.stockAlertCount ?? 0) > 0
                ? "font-mono font-medium tabular-nums text-amber-700"
                : "font-mono font-medium tabular-nums text-navy/50"
            }
          >
            {product.stockAlertCount ?? 0} waiting for restock
          </span>
        </div>
        <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
          <span className="text-navy/70">Avg cost</span>
          {product.averageCost != null ? (
            <span className="font-mono font-medium tabular-nums text-navy">
              ${parseFloat(String(product.averageCost)).toFixed(2)}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onSetCost()}
              title="No cost basis recorded — click to set one"
              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 transition-colors hover:bg-amber-200"
            >
              No cost set
            </button>
          )}
        </div>
        <Link
          href={`/inventory/movements?product=${product.id}`}
          className="block py-3 text-xs font-semibold text-brand-600 hover:underline"
        >
          View stock movements →
        </Link>
      </div>
    </div>
  );
}
