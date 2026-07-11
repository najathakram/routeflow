"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/**
 * Decimal text inputs that NEVER reformat while the user is typing — the fix
 * for the "type 2.50, get 2.05" family of bugs. Two rules make it safe:
 *
 * 1. The visible text lives in LOCAL state. While the field is focused it is
 *    only sanitized (digits + one dot + ≤`decimals` places), never re-derived
 *    from the parsed number, so intermediate states like "2." and "" survive.
 * 2. The parent receives `parsed | null` on every keystroke (totals stay live),
 *    and external `value` changes are echoed into the text ONLY while the
 *    field is not focused (supports cross-field lenses like price ↔ $-off).
 *
 * Formatting to a fixed number of decimals happens exactly once: on blur.
 */

/** Strip anything but digits + one dot (+ optional leading minus); clamp decimal places; "." → "0.". */
export function sanitizeDecimalText(raw: string, decimals: number, allowNegative = false): string {
  const negative = allowNegative && raw.trimStart().startsWith("-");
  let out = "";
  let seenDot = false;
  for (const ch of raw.replace(/,/g, ".")) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !seenDot && decimals > 0) {
      seenDot = true;
      out += ".";
    }
  }
  if (out.startsWith(".")) out = `0${out}`;
  if (seenDot) {
    const [whole, frac = ""] = out.split(".");
    out = `${whole}.${frac.slice(0, decimals)}`;
  }
  return negative ? `-${out}` : out;
}

export interface DecimalInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
> {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Max fractional digits while typing; also the blur format. Default 2. */
  decimals?: number;
  min?: number;
  max?: number;
  /** Permit a leading "-" (e.g. invoice adjustments). Default false. */
  allowNegative?: boolean;
  selectOnFocus?: boolean;
}

export const DecimalInput = React.forwardRef<HTMLInputElement, DecimalInputProps>(
  function DecimalInput(
    {
      value,
      onChange,
      decimals = 2,
      min,
      max,
      allowNegative = false,
      selectOnFocus = true,
      className,
      ...rest
    },
    ref,
  ) {
    const [text, setText] = React.useState(value == null ? "" : value.toFixed(decimals));
    const focusedRef = React.useRef(false);

    // Echo external value changes into the text ONLY while unfocused — this is
    // what replaces the old reformat-on-every-render/useEffect behavior.
    React.useEffect(() => {
      if (focusedRef.current) return;
      const current = text === "" ? null : parseFloat(text);
      const same =
        (value == null && current == null) ||
        (value != null && current != null && Math.abs(current - value) < 1e-9);
      if (!same) setText(value == null ? "" : value.toFixed(decimals));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, decimals]);

    const clamp = (n: number): number => {
      let v = n;
      if (min != null && v < min) v = min;
      if (max != null && v > max) v = max;
      return v;
    };

    return (
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onFocus={(e) => {
          focusedRef.current = true;
          if (selectOnFocus) e.currentTarget.select();
        }}
        onChange={(e) => {
          const sanitized = sanitizeDecimalText(e.target.value, decimals, allowNegative);
          setText(sanitized);
          const parsed = sanitized === "" || sanitized === "-" ? null : parseFloat(sanitized);
          onChange(parsed == null || Number.isNaN(parsed) ? null : clamp(parsed));
        }}
        onBlur={() => {
          focusedRef.current = false;
          const parsed = text === "" || text === "-" ? null : parseFloat(text);
          if (parsed == null || Number.isNaN(parsed)) {
            setText(value == null ? "" : value.toFixed(decimals));
          } else {
            const clamped = clamp(parsed);
            setText(clamped.toFixed(decimals));
            if (clamped !== parsed) onChange(clamped);
          }
        }}
        className={cn(
          "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
          className,
        )}
        {...rest}
      />
    );
  },
);

export type MoneyInputProps = Omit<DecimalInputProps, "decimals">;

/** DecimalInput fixed to cents — the standard money field. */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  function MoneyInput(props, ref) {
    return <DecimalInput ref={ref} decimals={2} {...props} />;
  },
);
