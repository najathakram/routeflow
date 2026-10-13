"use client";

import * as React from "react";
import { Plus, Minus, Trash2 } from "lucide-react";
import { useUndo } from "@/lib/undo";

// ─── Quantity Stepper ─────────────────────────────────────────────────────────

/**
 * One 44px-high segmented control: [ − or trash | qty | + ]. The left segment is "−" at qty >= 2 and a
 * trash at qty 1, so there is no separate remove button. Removing at any qty (trash, or typing 0 / clearing
 * the field) is one action and shows a "Removed <name>." toast with an Undo that restores the line.
 */
export function QtyStepper({
  qty,
  name,
  onUpdate,
  onRemove,
  onRestore,
  size = "md",
  stack = false,
}: {
  qty: number;
  /** Product name — used for the accessible names and the Undo toast. */
  name: string;
  onUpdate: (qty: number) => void;
  onRemove: () => void;
  /** Puts the removed line back (the caller re-adds the pre-removal cart line). Undo is shown only when given. */
  onRestore?: () => void;
  size?: "sm" | "md";
  /** Below `sm` take the whole row of the parent; from `sm` up stay inline. For the narrow 2-column tile. */
  stack?: boolean;
}) {
  const runUndoable = useUndo();
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
    const n = parseInt(trimmed, 10);
    if (trimmed === "" || n <= 0) {
      remove();
    } else if (!isNaN(n)) {
      if (n !== qty) onUpdate(n);
      setInputVal(String(n));
    } else {
      // Revert to current qty if invalid
      setInputVal(String(qty));
    }
  };

  // 44px hit area on every segment; only the icon size differs between sm and md.
  const btnCls =
    "flex min-h-11 min-w-11 items-center justify-center text-buyer-600 hover:bg-buyer-100 transition-colors";
  const iconCls = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <div
      data-qty-stepper
      className={`grid h-11 grid-cols-[44px_minmax(36px,1fr)_44px] gap-0 overflow-hidden rounded-lg border border-buyer-200 bg-buyer-50 ${stack ? "w-full sm:w-auto" : ""}`}
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
      <button
        type="button"
        onClick={() => onUpdate(qty + 1)}
        className={btnCls}
        aria-label={`Increase ${name}`}
      >
        <Plus className={iconCls} />
      </button>
    </div>
  );
}

export default QtyStepper;
