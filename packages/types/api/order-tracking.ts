// ─── Order tracking (#2095) ─────────────────────────────────────────────────────
//
// The ONE wire shape of `GET /orders/:id/tracking` (staff) and `GET /buyer/orders/:id/tracking`
// (buyer portal). Both are served by `apps/api/src/orders/order-tracking.ts`, which is typed
// against `OrderTrackingResponse`, so a server change that drifts from what web and mobile read
// fails `check-types` instead of shipping. The API may only `import type` from this package: it
// has no build step, so a runtime import would reach Node as TypeScript. `isTrackingLive` below
// is therefore a client-side helper (web + mobile).

import type { OrderStatusValue, RouteRunStatusValue, RouteRunStopStatusValue } from "./enums";

/** An order's place on the route run it is booked on. */
export interface OrderTracking {
  runId: string;
  /**
   * The seller's internal route label. Always null for a customer-facing caller (a buyer, or a
   * CUSTOMER-role user): it is free text the seller writes, so it could name other customers.
   */
  routeName: string | null;
  /**
   * The assigned driver. A customer-facing caller gets the first name only; staff get the full
   * contact name. Null when no driver is assigned.
   */
  driverName: string | null;
  runStatus: RouteRunStatusValue;
  /** This order's own position on the run (1-based). */
  stopNumber: number;
  stopStatus: RouteRunStopStatusValue;
  /**
   * How many stops the driver still has to work before this one: the run's stops with a lower
   * stopNumber that are PENDING or IN_PROGRESS. A count only, never who or where they are.
   */
  stopsAhead: number;
  /** The run's scheduled calendar date (ISO, UTC midnight: render with a UTC-anchored formatter). */
  scheduledDate: string;
  /**
   * The customer's own delivery window ("HH:mm", either end may be null). A static preference
   * window, not a computed ETA (B175).
   */
  estimatedArrivalWindow: { start: string | null; end: string | null };
}

export interface OrderTrackingResponse {
  /** The order's own status (the same value the order detail returns). */
  status: OrderStatusValue;
  /**
   * Null when the order is not on a live route run: never scheduled, released from its run, or
   * the run was cancelled (F11: a cancelled run never shows a driver).
   */
  tracking: OrderTracking | null;
}

/**
 * Whether a tracking payload can still change without the buyer doing anything, so a client
 * should keep refreshing it: the order is OUT_FOR_DELIVERY or PARTIALLY_DELIVERED, or its run is
 * IN_PROGRESS (a CONFIRMED order on a live run must still see its own stop get skipped, F11/B146).
 * A DELIVERED or CANCELLED order is never live, even while its run still is: a terminal order
 * keeps its stop pointer, so its payload goes on reporting the run for the rest of the trip.
 * Each client picks its own interval; this is the one rule for WHEN.
 */
export function isTrackingLive(
  data: { status: string; tracking: { runStatus: string } | null } | null | undefined,
): boolean {
  if (!data) return false;
  if (data.status === "DELIVERED" || data.status === "CANCELLED") return false;
  if (data.status === "OUT_FOR_DELIVERY" || data.status === "PARTIALLY_DELIVERED") return true;
  return data.tracking?.runStatus === "IN_PROGRESS";
}
