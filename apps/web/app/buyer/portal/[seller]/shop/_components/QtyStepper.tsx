"use client";

import * as React from "react";
import { Plus, Minus, X } from "lucide-react";

// ─── Quantity Stepper ─────────────────────────────────────────────────────────

export function QtyStepper({
  qty,
  onUpdate,
  onRemove,
  size = "md",
  stack = false,
}: {
  qty: number;
  onUpdate: (qty: number) => void;
  onRemove: () => void;
  size?: "sm" | "md";
  /** Below `sm` take a whole row of the parent (the field flexes); from `sm` up stay inline. For the narrow 2-column tile. */
  stack?: boolean;
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

  // 44px hit area on both sizes; only the icon and the field width differ between sm and md.
  const btnCls =
    "flex min-h-11 min-w-11 items-center justify-center text-buyer-600 hover:bg-buyer-100 transition-colors disabled:opacity-40";

  const iconCls = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const inputW = stack ? (size === "sm" ? "sm:w-7" : "sm:w-8") : size === "sm" ? "w-7" : "w-8";

  return (
    <div data-qty-stepper className={`flex items-center gap-1 ${stack ? "w-full sm:w-auto" : ""}`}>
      {/* Red X remove button */}
      <button
        onClick={onRemove}
        className="flex min-h-11 min-w-11 items-center justify-center rounded p-0.5 text-danger/60 hover:bg-danger/10 hover:text-danger transition-colors"
        title="Remove from cart"
        aria-label="Remove from cart"
      >
        <X className={iconCls} />
      </button>

      {/* Stepper group */}
      <div
        className={`flex items-center rounded-lg border border-buyer-200 bg-buyer-50 ${stack ? "min-w-0 flex-1 sm:flex-none" : ""}`}
      >
        <button
          onClick={() => {
            if (qty > 1) onUpdate(qty - 1);
          }}
          className={`rounded-l-lg ${btnCls}`}
          disabled={qty <= 1}
          aria-label="Decrease quantity"
        >
          <Minus className={iconCls} />
        </button>
        <input
          type="number"
          min={1}
          aria-label="Quantity"
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
          className={`h-11 ${stack ? "min-w-0 flex-1 sm:flex-none" : ""} ${inputW} border-none bg-transparent text-center text-sm font-semibold text-buyer-700 focus:outline-none focus:ring-1 focus:ring-buyer-400 rounded [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
        />
        <button
          onClick={() => onUpdate(qty + 1)}
          className={`rounded-r-lg ${btnCls}`}
          aria-label="Increase quantity"
        >
          <Plus className={iconCls} />
        </button>
      </div>
    </div>
  );
}

export default QtyStepper;
