"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { DecimalInput } from "@/components/MoneyInput";
import type { StockCountMode, StockCountRow as Row } from "@/lib/stock-count-storage";

const DECIMAL_UNITS = ["kg", "g", "liter", "litre", "l", "oz", "lb", "pound", "ml"];
function isDecimalUnit(unit: string) {
  return DECIMAL_UNITS.includes(unit.toLowerCase());
}

interface StockCountRowProps {
  row: Row;
  selected: boolean;
  flashing: boolean;
  onToggleSelect: (rowId: string) => void;
  onChangeQty: (rowId: string, qty: number) => void;
  onChangeMode: (rowId: string, mode: StockCountMode) => void;
  onRemove: (rowId: string) => void;
}

export const StockCountRow = React.memo(function StockCountRow({
  row,
  selected,
  flashing,
  onToggleSelect,
  onChangeQty,
  onChangeMode,
  onRemove,
}: StockCountRowProps) {
  const decimals = isDecimalUnit(row.unit) ? 3 : 0;
  const delta = row.mode === "REPLACE" ? row.scannedQty - row.currentStockSnapshot : row.scannedQty;
  const replacingDown = row.mode === "REPLACE" && row.scannedQty < row.currentStockSnapshot;

  return (
    <tr
      className={cn(
        "border-b border-surface-border transition-colors",
        flashing ? "bg-brand-50" : "hover:bg-surface-raised",
      )}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(row.rowId)}
          className="h-4 w-4 cursor-pointer rounded border-surface-border accent-brand-500"
        />
      </td>
      <td className="px-3 py-2">
        <div className="text-sm font-medium text-navy">{row.name}</div>
        <div className="text-xs text-navy/70">
          {row.sku ? `${row.sku} · ` : ""}
          {row.unit}
        </div>
      </td>
      <td className="px-3 py-2 text-right text-sm text-navy/70">{row.currentStockSnapshot}</td>
      <td className="px-3 py-2">
        <DecimalInput
          value={row.scannedQty}
          onChange={(v) => onChangeQty(row.rowId, v ?? 0)}
          decimals={decimals}
          min={0}
          max={9999999.999}
          className="w-24 px-2 py-1 text-right"
        />
      </td>
      <td className="px-3 py-2">
        <select
          value={row.mode}
          onChange={(e) => onChangeMode(row.rowId, e.target.value as StockCountMode)}
          className="rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="ADD">Add to existing</option>
          <option value="REPLACE">Replace count</option>
        </select>
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right text-sm font-medium",
          delta > 0 ? "text-success" : delta < 0 ? "text-danger" : "text-navy/70",
        )}
      >
        {delta > 0 ? "+" : ""}
        {delta}
        {replacingDown && <div className="text-[10px] font-normal text-warning">below current</div>}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={() => onRemove(row.rowId)}
          className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-danger"
          title="Remove row"
        >
          <Trash2 size={16} />
        </button>
      </td>
    </tr>
  );
});
