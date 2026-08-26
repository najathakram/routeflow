"use client";

import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { TripIneligibleReason } from "@/lib/api/routes";

export type TripSkippedReason = TripIneligibleReason | "NO_CUSTOMER";

export interface TripSkippedRow {
  orderId: string;
  orderNumber: string | null;
  reason: TripSkippedReason;
  detail?: string | null;
}

const REASON_LABELS: Record<TripSkippedReason, string> = {
  SHIP_FULFILLMENT: "Ships via carrier — not routed",
  INELIGIBLE_STATUS: "Not in an open status",
  ON_ACTIVE_RUN: "Already on an active run",
  PREVIOUSLY_DISPATCHED: "Attached to a finished run",
  NO_ADDRESS: "Customer has no delivery address",
  NOT_FOUND: "Order not found",
  NO_CUSTOMER: "No customer on this order",
};

export interface TripSkippedPanelProps {
  rows: TripSkippedRow[];
  className?: string;
}

/**
 * Nothing silently missing (Design directive 2): every order that didn't make
 * it into a stop is listed here with a human reason, sourced from the server's
 * eligibility payload (SHIP/status/run/address reasons) and from
 * groupOrdersForTrip's NO_CUSTOMER client-side check. Always renders — an empty
 * skip list is confirmed explicitly rather than just omitted.
 */
export function TripSkippedPanel({ rows, className }: TripSkippedPanelProps) {
  return (
    <div className={cn("rounded-lg border border-surface-border bg-white", className)}>
      <div className="flex items-center gap-1.5 border-b border-surface-border px-3 py-2">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-navy/70">
          Skipped ({rows.length})
        </h3>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-3 text-xs text-navy/70">
          All selected orders are eligible for this delivery.
        </p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {rows.map((row) => (
            <li key={row.orderId} className="flex items-start justify-between gap-3 px-3 py-2">
              <span className="shrink-0 text-sm font-medium text-navy">
                #{row.orderNumber ?? row.orderId.slice(0, 8).toUpperCase()}
              </span>
              <span className="text-right text-xs text-navy/70">
                {row.detail || REASON_LABELS[row.reason] || "Not eligible"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-start gap-1.5 border-t border-surface-border bg-surface-raised px-3 py-2 text-[11px] text-navy/70">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />A customer with orders at more than
        one address still gets a single stop — deliveries are grouped by customer, not by address.
      </p>
    </div>
  );
}
