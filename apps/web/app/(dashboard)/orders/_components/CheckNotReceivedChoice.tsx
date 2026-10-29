"use client";

import * as React from "react";
import { CHECK_NOT_RECEIVED_LABEL } from "@/lib/counter-sale";

/**
 * SA-1026 A: the one choice inside the Check tender, shared by the till and the hand-over dialog. The customer's check is
 * not in hand yet, so the sale is saved On account and read back as "To collect". The parent hides it for a walk-in (there is
 * no account to collect on) and hides the check fields while it is on. Props in, no fetching.
 */
export function CheckNotReceivedChoice({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-[44px] items-center gap-2 text-sm">
      <input
        type="checkbox"
        aria-label={CHECK_NOT_RECEIVED_LABEL}
        className="h-5 w-5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {CHECK_NOT_RECEIVED_LABEL}
    </label>
  );
}
