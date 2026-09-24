"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/**
 * Bill mode's "Raise a purchase order" switch. A blocked switch stays visible with its reason — hiding it
 * would leave the operator wondering where the option went.
 */
export function RaisePoToggle({
  checked,
  blocker,
  onChange,
}: {
  checked: boolean;
  blocker: string | null;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="col-span-2 rounded-lg border border-surface-border bg-surface-bg px-3 py-2">
      <label
        className={cn(
          "flex items-start gap-2 text-sm text-navy",
          blocker ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={checked && !blocker}
          disabled={!!blocker}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="raise-po-toggle"
        />
        <span>
          <span className="font-medium">Raise a purchase order from these lines</span>
          <span className="block text-xs text-navy/70">
            {blocker ??
              "The bill records the money; stock is added when you receive the purchase order."}
          </span>
        </span>
      </label>
    </div>
  );
}
