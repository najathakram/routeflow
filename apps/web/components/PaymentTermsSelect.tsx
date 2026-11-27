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
  /** R-345 F6: told whether the custom box shows an error, so a create or edit form can hold its submit (mobile parity). */
  onInvalidChange?: (invalid: boolean) => void;
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
  onInvalidChange,
}: PaymentTermsSelectProps) {
  const storedCustom = value !== "" && !isPreset(value) && termDays(value) !== null;
  const [customChosen, setCustomChosen] = React.useState(false);
  const [days, setDays] = React.useState(storedCustom ? String(termDays(value)) : "");
  const [error, setError] = React.useState<string | null>(null);
  const showCustom = customChosen || storedCustom;
  const invalidRef = React.useRef(onInvalidChange);
  invalidRef.current = onInvalidChange;
  React.useEffect(() => {
    invalidRef.current?.(error !== null);
  }, [error]);
  // The last label THIS field reported: a different value arriving means the parent changed it (a hand-typed due date
  // clears the term, a record loads), so the custom box closes instead of showing a stale number.
  const reported = React.useRef(value);
  React.useEffect(() => {
    if (value !== reported.current) {
      reported.current = value;
      setCustomChosen(false);
      // R-345d N2: the closed box takes its error and typed days with it, so no form stays held by a hidden error.
      setError(null);
      setDays("");
    }
  }, [value]);
  const report = (label: string) => {
    reported.current = label;
    onChange(label);
  };

  // A stored custom label that changes from outside (a loaded record) refreshes the box, but never while the user is
  // typing in it (a refetch must not overwrite half a number).
  const typing = React.useRef(false);
  React.useEffect(() => {
    if (storedCustom && !typing.current) setDays(String(termDays(value)));
  }, [storedCustom, value]);

  // The typed days are committed on blur or Enter only, and only when whole and 1-365: a half-typed "4" of "45" must
  // never reach an autosaving parent. Anything else shows the inline error and reports nothing.
  const commit = () => {
    typing.current = false;
    const typed = days.trim();
    if (typed === "") {
      setError(null);
      return;
    }
    const label = /^\d+$/.test(typed) ? netLabel(Number(typed)) : null;
    if (label === null) {
      setError(
        `Enter a whole number of days from ${PAYMENT_TERM_MIN_DAYS} to ${PAYMENT_TERM_MAX_DAYS}.`,
      );
      return;
    }
    setError(null);
    if (label !== reported.current) report(label);
  };

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
            onFocus={() => {
              typing.current = true;
            }}
            onChange={(e) => {
              typing.current = true;
              setDays(e.target.value);
              setError(null);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
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
