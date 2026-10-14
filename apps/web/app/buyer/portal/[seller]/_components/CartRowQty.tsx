"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { lineCount, type CartLineShape, type CartUnit } from "@/lib/buyer-cart-line";
import { CartLineUnit } from "./CartLineUnit";

/**
 * The cart row's quantity control (row 531): one 44px segmented stepper [ − | count | + ] that
 * counts the line's SELLING UNIT, with the unit named underneath and a Case / Each toggle for a
 * boxed line (`CartLineUnit`). It replaces the old boxes field + pcs field, which each re-spread
 * the line and drifted (the reading jumped to 16, then 30, while the subtotal stayed). Every edit
 * goes through the cart hook, which re-derives `qty`, `boxes` and `pieces` together, so there is
 * no second source for the field to snap back to. Any whole-piece quantity is still reachable:
 * switch to Each and type it.
 *
 * The field commits on blur or Enter (typing never moves the cart mid-keystroke); an empty or
 * zero entry reverts, and the Trash button stays the one way to remove a line. `−` at 1 removes.
 */
export function CartRowQty({
  item,
  name,
  onCount,
  onUnit,
  onRemove,
  align = "center",
}: {
  item: CartLineShape;
  name: string;
  /** The new count, in the line's selling unit. */
  onCount: (count: number) => void;
  onUnit: (unit: CartUnit) => void;
  onRemove: () => void;
  /** Below md it is always left-aligned; from md up a table cell centres it, a card keeps it left. */
  align?: "center" | "start";
}) {
  const count = lineCount(item);
  const [val, setVal] = React.useState(String(count));
  React.useEffect(() => setVal(String(count)), [count]);

  const commit = (raw: string) => {
    const n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      setVal(String(count));
      return;
    }
    if (n !== count) onCount(n);
    setVal(String(n));
  };

  const btn =
    "flex min-h-11 min-w-11 items-center justify-center text-buyer-600 transition-colors hover:bg-buyer-100";
  return (
    <div
      className={`flex flex-col items-start gap-1.5 ${align === "center" ? "md:items-center" : ""}`}
    >
      <div
        data-testid="cart-row-stepper"
        className="grid h-11 grid-cols-[44px_minmax(36px,64px)_44px] overflow-hidden rounded-lg border border-buyer-200 bg-buyer-50"
      >
        <button
          type="button"
          aria-label={`Decrease ${name}`}
          onClick={() => (count <= 1 ? onRemove() : onCount(count - 1))}
          className={btn}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          aria-label={`Quantity, ${name}`}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="h-11 w-full border-none bg-transparent p-0 text-center text-sm font-semibold tabular-nums text-buyer-700 focus:outline-none focus:ring-1 focus:ring-buyer-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button
          type="button"
          aria-label={`Increase ${name}`}
          onClick={() => onCount(count + 1)}
          className={btn}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <CartLineUnit item={item} name={name} onUnit={onUnit} />
    </div>
  );
}

export default CartRowQty;
