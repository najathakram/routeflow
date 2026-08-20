"use client";

import * as React from "react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { useSetCostBasis } from "@/lib/api/inventory";

/**
 * Minimal shape `SetCostModal` needs to render and submit. Satisfied
 * structurally by both the Inventory Stock tab's `StockItem` and the product
 * detail page's `ApiProduct` (after normalizing `averageCost` to a number).
 */
export interface CostBasisTarget {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  averageCost: number | null;
}

/**
 * Sets a product's average cost basis. This is the ONLY sanctioned way to
 * change a cost — the mutation always writes an audited COST_BASIS stock
 * movement server-side, so a raw editable cost field elsewhere would bypass
 * the audit trail. Shared by the Inventory Stock tab (table row + search
 * suggestions) and the product detail page's "Stock & Cost" card.
 */
export function SetCostModal({ item, onClose }: { item: CostBasisTarget; onClose: () => void }) {
  const setCostBasis = useSetCostBasis();
  const { toast } = useToast();
  const [unitCost, setUnitCost] = React.useState(
    item.averageCost != null ? String(item.averageCost) : "",
  );
  const [notes, setNotes] = React.useState("");
  const [applyToLots, setApplyToLots] = React.useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCostBasis.mutate(
      {
        productId: item.id,
        unitCost: Number(unitCost),
        notes: notes || undefined,
        applyToLots: applyToLots || undefined,
      },
      {
        onSuccess: () => {
          toast({
            title: "Cost basis set",
            description: `${item.name} now carries a unit cost of $${Number(unitCost).toFixed(4)}.`,
            variant: "success",
          });
          onClose();
        },
        onError: () =>
          toast({
            title: "Failed to set cost",
            description: "Please try again.",
            variant: "error",
          }),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Set cost basis — ${item.name}`}
      description="Manually sets the average cost. Recorded as an audited COST_BASIS movement; future purchases keep updating the average from here."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs text-navy">Unit cost ($) *</label>
          <input
            required
            autoFocus
            type="number"
            min={0}
            step={0.0001}
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="0.0000"
          />
          <p className="mt-1 text-xs text-navy/70">
            Current: {item.averageCost != null ? `$${Number(item.averageCost).toFixed(4)}` : "none"}{" "}
            · Stock: {item.currentStock} {item.unit}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs text-navy">Notes</label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. opening cost basis from supplier price list"
            className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-navy/70">
          <input
            type="checkbox"
            checked={applyToLots}
            onChange={(e) => setApplyToLots(e.target.checked)}
          />
          Also rewrite open stock lots (FIFO/LIFO products)
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={setCostBasis.isPending}>
            Set Cost
          </Button>
        </div>
      </form>
    </Modal>
  );
}
