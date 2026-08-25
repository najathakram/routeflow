"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { TripStopGroup } from "@routeflow/types";

export interface TripStopOrderInfo {
  orderNumber: string | null;
}

export interface TripStopListProps {
  groups: TripStopGroup[];
  /** orderId → display info, built from the eligibility payload — lets each
   *  stop card show its order numbers without a second fetch. */
  orderLookup: Record<string, TripStopOrderInfo>;
  /** Omit to render read-only (used for the BUILT-phase review list). */
  onRemoveCustomer?: (customerId: string) => void;
  emptyMessage?: string;
  className?: string;
}

/**
 * One card per delivery stop (one per distinct customer, per groupOrdersForTrip).
 * Remove uses the same two-tap confirm idiom as the route-template stop list
 * (templates/[id]/page.tsx's SortableStop) — Design directive 3.
 */
export function TripStopList({
  groups,
  orderLookup,
  onRemoveCustomer,
  emptyMessage = "No stops yet.",
  className,
}: TripStopListProps) {
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);

  if (groups.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg border border-dashed border-surface-border p-6 text-center",
          className,
        )}
      >
        <p className="text-sm text-navy/70">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className={cn("space-y-2", className)}>
      {groups.map((group, index) => {
        const orderCount = group.orderIds.length;
        const orderLabels = group.orderIds.map((id) => {
          const info = orderLookup[id];
          return info?.orderNumber ? `#${info.orderNumber}` : `#${id.slice(0, 8).toUpperCase()}`;
        });
        return (
          <li
            key={group.customerId}
            className="flex items-start gap-3 rounded-lg border border-surface-border bg-white p-3"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-600">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-navy">
                {group.customerName ?? "Unknown customer"}
              </p>
              <p className="mt-0.5 truncate text-xs text-navy/70">
                {orderCount} order{orderCount !== 1 ? "s" : ""} · {orderLabels.join(", ")}
              </p>
            </div>
            {onRemoveCustomer && (
              <div
                className="flex shrink-0 items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                {confirmingId === group.customerId ? (
                  <>
                    <span className="text-xs font-medium text-danger">Remove?</span>
                    <button
                      onClick={() => {
                        onRemoveCustomer(group.customerId);
                        setConfirmingId(null);
                      }}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-white bg-danger hover:bg-danger/80 transition-colors"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmingId(null)}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-navy/70 hover:text-navy transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmingId(group.customerId)}
                    className="rounded p-1 text-navy/30 hover:bg-danger-bg hover:text-danger transition-colors"
                    aria-label={`Remove ${group.customerName ?? "this stop"}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
