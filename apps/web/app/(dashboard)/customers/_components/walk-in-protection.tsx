"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Badge, cn } from "@routeflow/ui/web";

/** Why the tenant's system walk-in customer (counter sales) offers no deactivate / remove / merge. */
export const WALK_IN_PROTECTED_COPY =
  "This is the walk-in customer for counter sales. It can't be deactivated, removed or merged.";

export const STATUS_CYCLE = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
export type CustomerStatus = (typeof STATUS_CYCLE)[number];

/**
 * The customer detail's Account Status card for a live (not removed) customer. The walk-in customer shows
 * its status and the reason, never the buttons the server would refuse (400 WALK_IN_PROTECTED).
 */
export function AccountStatusControls({
  isWalkIn,
  currentStatus,
  pending,
  onChange,
  onRemove,
}: {
  isWalkIn?: boolean | null;
  currentStatus: CustomerStatus;
  pending: boolean;
  onChange: (s: CustomerStatus) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-navy/70">Current status</p>
        <Badge status={currentStatus} />
      </div>
      {isWalkIn ? (
        <p className="text-sm text-navy/70">{WALK_IN_PROTECTED_COPY}</p>
      ) : (
        <>
          <div className="space-y-2">
            {STATUS_CYCLE.map((s) => (
              <button
                key={s}
                onClick={() => onChange(s)}
                disabled={pending}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                  currentStatus === s
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-surface-border text-navy/70 hover:border-navy/30 hover:text-navy",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    s === "ACTIVE" ? "bg-success" : s === "INACTIVE" ? "bg-navy/30" : "bg-danger",
                  )}
                />
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          {currentStatus === "SUSPENDED" && (
            <div className="border-t border-surface-border pt-4">
              <button
                onClick={onRemove}
                className="flex w-full items-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
              >
                <Trash2 className="h-4 w-4" />
                Remove customer
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
