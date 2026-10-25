"use client";

import * as React from "react";
import { partPayCopy } from "@/lib/counter-part-pay";

/**
 * SA-933 / W-822(a) S4: an identified customer's CHECK or CARD can pay part now; the rest goes on account. The field is the
 * same `tendered` value the cash field uses, so an empty field (or one covering the total) is a FULL payment and the request
 * carries no amount, exactly as before. Never drawn for a walk-in, who pays the whole total.
 */
export function CounterPartPayField({
  value,
  onChange,
  disabled,
  inputRef,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  inputRef: React.Ref<HTMLInputElement>;
  onEnter: () => void;
}) {
  return (
    <label className="block text-sm" data-testid="counter-part-pay-field">
      Amount paying now
      <input
        ref={inputRef}
        aria-label="Amount paying now"
        aria-describedby="counter-part-pay-hint"
        inputMode="decimal"
        className="mt-1 min-h-[44px] w-full rounded border px-3 py-2"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <span id="counter-part-pay-hint" className="mt-1 block text-navy/70">
        Leave empty to pay in full. The rest goes on account.
      </span>
    </label>
  );
}

/** "Pay $X now · $Y goes on account", shown in the checkout bar while an identified customer's tender is short. */
export function CounterPartPaySplit({
  split,
  creditMayApply = false,
}: {
  split: { now: number; onAccount: number };
  creditMayApply?: boolean;
}) {
  return (
    <p className="text-sm font-medium" role="status" data-testid="counter-part-pay-split">
      {partPayCopy(split, creditMayApply)}
    </p>
  );
}
