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
  /**
   * Removes a single order from a multi-order customer group without
   * dropping the whole stop. Omit to render read-only (BUILT-phase review
   * list); groups with exactly one order never show this control — the
   * whole-customer remove above already covers that case.
   */
  onRemoveOrder?: (orderId: string) => void;
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
  onRemoveOrder,
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
        const orderLabel = (id: string) => {
          const info = orderLookup[id];
          return info?.orderNumber ? `#${info.orderNumber}` : `#${id.slice(0, 8).toUpperCase()}`;
        };
        const orderLabels = group.orderIds.map(orderLabel);
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
              {onRemoveOrder && orderCount > 1 ? (
                // Per-order removal only makes sense once there's more than one
                // order to choose between — a single-order group keeps the plain
                // summary line below and relies on the customer-level remove.
                <ul className="mt-1 space-y-1">
                  {group.orderIds.map((id) => (
                    <li
                      key={id}
                      className="flex items-center justify-between gap-2 rounded bg-surface-raised px-2 py-1"
                    >
                      <span className="truncate text-xs text-navy/70">{orderLabel(id)}</span>
                      <button
                        onClick={() => onRemoveOrder(id)}
                        className="shrink-0 rounded p-0.5 text-navy/30 hover:bg-danger-bg hover:text-danger transition-colors"
                        aria-label={`Remove order ${orderLabel(id)}`}
                        title={`Remove order ${orderLabel(id)}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-0.5 truncate text-xs text-navy/70">
                  {orderCount} order{orderCount !== 1 ? "s" : ""} · {orderLabels.join(", ")}
                </p>
              )}
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
