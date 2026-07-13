"use client";

import * as React from "react";
import { Plus, Minus, X } from "lucide-react";

// ─── Quantity Stepper ─────────────────────────────────────────────────────────

export function QtyStepper({
  qty,
  onUpdate,
  onRemove,
  size = "md",
}: {
  qty: number;
  onUpdate: (qty: number) => void;
  onRemove: () => void;
  size?: "sm" | "md";
}) {
  const [inputVal, setInputVal] = React.useState(String(qty));

  // Keep in sync when external qty changes (e.g. cart updated from elsewhere)
  React.useEffect(() => {
    setInputVal(String(qty));
  }, [qty]);

  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) {
      onUpdate(n);
      setInputVal(String(n));
    } else {
      // Revert to current qty if invalid
      setInputVal(String(qty));
    }
  };

  const btnCls =
    size === "sm"
      ? "p-1 text-buyer-600 hover:bg-buyer-100 transition-colors"
      : "p-1.5 text-buyer-600 hover:bg-buyer-100 transition-colors";

  const iconCls = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const inputW = size === "sm" ? "w-7" : "w-8";

  return (
    <div className="flex items-center gap-1">
      {/* Red X remove button */}
      <button
        onClick={onRemove}
        className="flex items-center justify-center rounded p-0.5 text-danger/60 hover:bg-danger/10 hover:text-danger transition-colors"
        title="Remove from cart"
      >
        <X className={iconCls} />
      </button>

      {/* Stepper group */}
      <div
        className={`flex items-center rounded-lg border border-buyer-200 bg-buyer-50 ${size === "sm" ? "gap-0" : "gap-0"}`}
      >
        <button
          onClick={() => {
            if (qty > 1) onUpdate(qty - 1);
          }}
          className={`rounded-l-lg ${btnCls}`}
          disabled={qty <= 1}
        >
          <Minus className={iconCls} />
        </button>
        <input
          type="number"
          min={1}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setInputVal(String(qty));
              e.currentTarget.blur();
            }
          }}
          className={`${inputW} border-none bg-transparent text-center text-sm font-semibold text-buyer-700 focus:outline-none focus:ring-1 focus:ring-buyer-400 rounded [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
        />
        <button onClick={() => onUpdate(qty + 1)} className={`rounded-r-lg ${btnCls}`}>
          <Plus className={iconCls} />
        </button>
      </div>
    </div>
  );
}

export default QtyStepper;
