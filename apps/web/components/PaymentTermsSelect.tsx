"use client";

import * as React from "react";
import {
  PAYMENT_TERM_MAX_DAYS,
  PAYMENT_TERM_MIN_DAYS,
  PAYMENT_TERM_PRESETS,
  netLabel,
  termDays,
} from "@routeflow/types/payment-terms";

/**
 * W-1487: the ONE payment-terms field: every preset (Due on Receipt, Net 7 ... Net 90) plus a custom "Net N" typed as a
 * number of days (1-365). A bad number (0, 366, 7.5) is refused inline and never reported, so the parent only ever holds
 * a label the API accepts. `value` is the stored label ("" = none); `emptyLabel` names the "" choice when the form has one.
 */
const CUSTOM = "__custom__";
const SELECT_CLASS =
  "rounded border border-surface-border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

export interface PaymentTermsSelectProps {
  value: string;
  onChange: (label: string) => void;
  /** Label of the "" option (e.g. "Select terms…", "Use tenant default"); omit when the field cannot be empty. */
  emptyLabel?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

const isPreset = (v: string) => (PAYMENT_TERM_PRESETS as readonly string[]).includes(v);

export function PaymentTermsSelect({
  value,
  onChange,
  emptyLabel,
  id,
  className,
  disabled,
  "aria-label": ariaLabel,
}: PaymentTermsSelectProps) {
  const storedCustom = value !== "" && !isPreset(value) && termDays(value) !== null;
  const [customChosen, setCustomChosen] = React.useState(false);
  const [days, setDays] = React.useState(storedCustom ? String(termDays(value)) : "");
  const [error, setError] = React.useState<string | null>(null);
  const showCustom = customChosen || storedCustom;
  // The last label THIS field reported: a different value arriving means the parent changed it (a hand-typed due date
  // clears the term, a record loads), so the custom box closes instead of showing a stale number.
  const reported = React.useRef(value);
  React.useEffect(() => {
    if (value !== reported.current) {
      reported.current = value;
      setCustomChosen(false);
    }
  }, [value]);
  const report = (label: string) => {
    reported.current = label;
    onChange(label);
  };

  // A stored custom label that changes from outside (a loaded record) refreshes the box.
  React.useEffect(() => {
    if (storedCustom) setDays(String(termDays(value)));
  }, [storedCustom, value]);

  const selectValue = showCustom ? CUSTOM : value;

  return (
    <div className="flex flex-col gap-1">
      <select
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        value={selectValue}
        className={className ?? SELECT_CLASS}
        onChange={(e) => {
          const next = e.target.value;
          setError(null);
          if (next === CUSTOM) {
            setCustomChosen(true);
            setDays("");
            return;
          }
          setCustomChosen(false);
          report(next);
        }}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {PAYMENT_TERM_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value={CUSTOM}>Custom (Net N)…</option>
      </select>
      {showCustom && (
        <>
          <input
            type="number"
            inputMode="numeric"
            min={PAYMENT_TERM_MIN_DAYS}
            max={PAYMENT_TERM_MAX_DAYS}
            step={1}
            aria-label="Number of days"
            aria-invalid={error ? true : undefined}
            disabled={disabled}
            value={days}
            placeholder="Days"
            className={className ?? SELECT_CLASS}
            onChange={(e) => {
              const typed = e.target.value;
              setDays(typed);
              if (typed.trim() === "") {
                setError(null);
                return;
              }
              const label = /^\d+$/.test(typed.trim()) ? netLabel(Number(typed)) : null;
              if (label === null) {
                setError(
                  `Enter a whole number of days from ${PAYMENT_TERM_MIN_DAYS} to ${PAYMENT_TERM_MAX_DAYS}.`,
                );
                return;
              }
              setError(null);
              report(label);
            }}
          />
          {error && (
            <span role="alert" className="text-xs text-red-600">
              {error}
            </span>
          )}
        </>
      )}
    </div>
  );
}
