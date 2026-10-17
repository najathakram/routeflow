"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@routeflow/ui/web";

/** The server's cap on a single add-on quantity (`EnableAddonDto` @Max(10000)). */
export const ADDON_QTY_MAX = 10_000;

const clamp = (n: number, max: number) => Math.min(Math.max(1, n), Math.max(1, max));

/**
 * A whole-number quantity stepper for a stackable add-on: `-` / typed value / `+`, min 1, max `max`.
 * Typing is free-form while focused (an empty box is allowed mid-edit); the value commits on every
 * valid digit string and snaps back to the last good number on blur.
 */
export function AddonQuantityStepper({
  value,
  onChange,
  max = ADDON_QTY_MAX,
  disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  max?: number;
  disabled?: boolean;
}) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);

  const step = "min-h-11 min-w-11 sm:min-h-9 sm:min-w-9";
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={step}
        aria-label="Decrease quantity"
        disabled={disabled || value <= 1}
        onClick={() => onChange(clamp(value - 1, max))}
      >
        <Minus className="h-4 w-4" />
      </Button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label="Quantity"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(0, 5);
          if (digits === "") return setText("");
          const next = clamp(Number(digits), max);
          setText(next === Number(digits) ? digits : String(next));
          onChange(next);
        }}
        onBlur={() => setText(String(value))}
        className="h-11 w-16 rounded border border-surface-border bg-white px-2 text-center text-sm tabular-nums text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50 sm:h-9"
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={step}
        aria-label="Increase quantity"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1, max))}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
