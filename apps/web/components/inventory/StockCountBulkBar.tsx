"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import type { StockCountMode } from "@/lib/stock-count-storage";

interface StockCountBulkBarProps {
  selectedCount: number;
  onApplyMode: (mode: StockCountMode) => void;
  onApplyQty: (qty: number) => void;
  onClearSelection: () => void;
  onRemoveSelected: () => void;
}

export function StockCountBulkBar({
  selectedCount,
  onApplyMode,
  onApplyQty,
  onClearSelection,
  onRemoveSelected,
}: StockCountBulkBarProps) {
  const [bulkQty, setBulkQty] = React.useState<string>("");

  if (selectedCount < 2) return null;

  const submitBulkQty = () => {
    const n = Number(bulkQty);
    if (!Number.isFinite(n) || n < 0) return;
    onApplyQty(n);
    setBulkQty("");
  };

  return (
    <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5">
      <span className="text-sm font-medium text-brand-700">
        {selectedCount} selected
      </span>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-brand-700/70">Set mode:</span>
        <Button variant="secondary" size="sm" onClick={() => onApplyMode("ADD")}>
          Add to existing
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onApplyMode("REPLACE")}>
          Replace count
        </Button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-brand-700/70">Set qty:</span>
        <input
          type="number"
          min={0}
          step={0.001}
          value={bulkQty}
          onChange={(e) => setBulkQty(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitBulkQty();
          }}
          placeholder="0"
          className="w-20 rounded border border-brand-200 bg-white px-2 py-1 text-right text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button variant="secondary" size="sm" onClick={submitBulkQty}>
          Apply
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={onClearSelection}>
          Clear
        </Button>
        <Button variant="secondary" size="sm" onClick={onRemoveSelected}>
          Remove rows
        </Button>
      </div>
    </div>
  );
}
