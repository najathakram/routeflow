"use client";

import * as React from "react";
import { Plus, Minus, Trash2 } from "lucide-react";
import { useToast } from "@routeflow/ui/web";
import { BUYER_LINE_QTY_MAX } from "@routeflow/pricing";
import { limitLine } from "@/lib/buyer-cart-line";
import { useUndo } from "@/lib/undo";

const ENTRY_LINE = "Enter 1 or more. Enter 0 to remove.";

// ─── Quantity Stepper ─────────────────────────────────────────────────────────

/**
 * One 44px-high segmented control: [ − or trash | qty | + ]. The left segment is "−" at qty >= 2 and a
 * trash at qty 1, so there is no separate remove button. Removing at any qty (trash, or typing 0 / clearing
 * the field) is one action and shows a "Removed <name>." toast with an Undo that restores the line.
 * Nothing else removes: a negative or non-whole entry reverts, and a number above BUYER_LINE_QTY_MAX (the
 * server's own line limit) sets the box to the limit, each with one plain line (B1382).
 */
export function QtyStepper({
  qty,
  name,
  onUpdate,
  onRemove,
  onRestore,
  size = "md",
  stack = false,
  max = BUYER_LINE_QTY_MAX,
  maxWord,
}: {
  qty: number;
  /** Product name — used for the accessible names and the Undo toast. */
  name: string;
  onUpdate: (qty: number) => void;
  onRemove: () => void;
  /** Puts the removed line back (the caller re-adds the pre-removal cart line). Undo is shown only when given. */
  onRestore?: () => void;
  size?: "sm" | "md";
  /**
   * Take the whole row of the parent at EVERY width. For the narrow shop tile: at 1440 its 5-column grid left an
   * inline stepper 102px against the 124px it needs (44 + 36 + 44), and the "+" was clipped (row 531 R3).
   */
  stack?: boolean;
  /** The most the line may count (the cart hook clamps to the same number: `lineLimit` in buyer-cart-line.ts). */
  max?: number;
  /** The unit word shown in the limit line on a Case line ("cases"). */
  maxWord?: string;
}) {
  const runUndoable = useUndo();
  const { toast } = useToast();
  const [inputVal, setInputVal] = React.useState(String(qty));
  const skipBlurCommit = React.useRef(false);

  // Keep in sync when external qty changes (e.g. cart updated from elsewhere)
  React.useEffect(() => {
    setInputVal(String(qty));
  }, [qty]);

  const remove = () => {
    void runUndoable({
      message: `Removed ${name}.`,
      perform: onRemove,
      undo: () => onRestore?.(),
    });
  };

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "" || /^0+$/.test(trimmed)) {
      remove();
    } else if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const next = Math.min(n, max);
      if (n > max) toast({ title: limitLine(max, maxWord), variant: "info" });
      if (next !== qty) onUpdate(next);
      setInputVal(String(next));
    } else {
      // Negative, decimal, exponent or text: never a removal. Back to the current qty.
      toast({ title: ENTRY_LINE, variant: "info" });
      setInputVal(String(qty));
    }
  };

  const increase = () => {
    if (qty >= max) {
      toast({ title: limitLine(max, maxWord), variant: "info" });
      return;
    }
    onUpdate(qty + 1);
  };

  // 44px hit area on every segment; only the icon size differs between sm and md.
  const btnCls =
    "flex min-h-11 min-w-11 items-center justify-center text-buyer-600 hover:bg-buyer-100 transition-colors";
  const iconCls = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <div
      data-qty-stepper
      className={`grid h-11 grid-cols-[44px_minmax(36px,1fr)_44px] gap-0 overflow-hidden rounded-lg border border-buyer-200 bg-buyer-50 ${stack ? "w-full" : ""}`}
    >
      {qty >= 2 ? (
        <button
          type="button"
          onClick={() => onUpdate(qty - 1)}
          className={btnCls}
          aria-label={`Decrease ${name}`}
        >
          <Minus className={iconCls} />
        </button>
      ) : (
        <button
          type="button"
          onClick={remove}
          className={`${btnCls} text-danger/70 hover:bg-danger/10 hover:text-danger`}
          aria-label={`Remove ${name} from cart`}
        >
          <Trash2 className={iconCls} />
        </button>
      )}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label="Quantity"
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onBlur={(e) => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
            return;
          }
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            skipBlurCommit.current = true;
            setInputVal(String(qty));
            e.currentTarget.blur();
          }
        }}
        className="h-11 min-w-[36px] w-full border-none bg-transparent p-0 text-center text-sm font-semibold tabular-nums text-buyer-700 focus:outline-none focus:ring-1 focus:ring-buyer-400 [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:m-0"
      />
      <button type="button" onClick={increase} className={btnCls} aria-label={`Increase ${name}`}>
        <Plus className={iconCls} />
      </button>
    </div>
  );
}

export default QtyStepper;
