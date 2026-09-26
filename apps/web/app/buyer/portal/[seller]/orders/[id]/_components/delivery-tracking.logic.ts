/**
 * #2095 — the rules behind the buyer's "Track your delivery" card, kept pure so every state is
 * provable without a DOM. The wire shape is the shared `OrderTracking`
 * (packages/types/api/order-tracking.ts); when the card refreshes is the query hook's rule
 * (`useBuyerOrderTracking` in lib/api/buyer.ts).
 */
import type { OrderTracking } from "@routeflow/types";

/** The buyer-facing driver identity: the first word only. The API already sends no more to a
 *  buyer; the card holds the same line, whatever it is handed. */
export function firstNameOnly(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** "You're next" / "1 stop before you" / "N stops before you". */
export function stopsBeforeYouLabel(stopsAhead: number): string {
  if (stopsAhead <= 0) return "You're next";
  return `${stopsAhead} stop${stopsAhead === 1 ? "" : "s"} before you`;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A customer window end ("HH:mm", 24h) as a 12-hour time; anything else as the seller wrote it. */
export function formatWindowTime(value: string): string {
  const trimmed = value.trim();
  const m = HH_MM.exec(trimmed);
  if (!m) return trimmed;
  const hours = Number(m[1]);
  const suffix = hours < 12 ? "AM" : "PM";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${m[2]} ${suffix}`;
}

/** The delivery window as one phrase, or null when the customer has none. */
export function formatDeliveryWindow(window: {
  start: string | null;
  end: string | null;
}): string | null {
  const start = window.start?.trim() ? formatWindowTime(window.start) : null;
  const end = window.end?.trim() ? formatWindowTime(window.end) : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `From ${start}`;
  if (end) return `By ${end}`;
  return null;
}

export type TrackingView =
  | { kind: "cancelled" }
  | { kind: "delivered"; deliveredAt: string | null }
  | { kind: "unscheduled" }
  | { kind: "out-for-delivery" }
  | { kind: "partly-delivered" }
  | { kind: "rescheduling" }
  | { kind: "skipped" }
  | { kind: "stop-completed" }
  | { kind: "route-finished" }
  | {
      kind: "scheduled";
      scheduledDate: string;
      driverName: string | null;
      window: string | null;
    }
  | { kind: "on-the-way"; stopsAhead: number; driverName: string | null; window: string | null }
  | { kind: "arriving"; driverName: string | null };

/**
 * Which state the card is in. The order's own status decides first (a cancelled or delivered
 * order is that, whatever its run says); then the own stop (a skipped or finished stop outranks
 * the run, so a skipped stop can never read "You're next"); then the run.
 */
export function deriveTrackingView(args: {
  status: string;
  deliveredAt: string | null | undefined;
  tracking: OrderTracking | null;
}): TrackingView {
  const { status, tracking } = args;
  if (status === "CANCELLED") return { kind: "cancelled" };
  if (status === "DELIVERED") return { kind: "delivered", deliveredAt: args.deliveredAt ?? null };

  if (!tracking) {
    if (status === "PARTIALLY_DELIVERED") return { kind: "partly-delivered" };
    if (status === "OUT_FOR_DELIVERY") return { kind: "out-for-delivery" };
    return { kind: "unscheduled" };
  }

  // Defensive: since F11 the API sends no tracking for a cancelled run.
  if (tracking.runStatus === "CANCELLED") return { kind: "rescheduling" };
  if (tracking.stopStatus === "SKIPPED") return { kind: "skipped" };
  if (tracking.stopStatus === "COMPLETED") {
    return status === "PARTIALLY_DELIVERED"
      ? { kind: "partly-delivered" }
      : { kind: "stop-completed" };
  }
  if (tracking.runStatus === "COMPLETED") return { kind: "route-finished" };

  const driverName = firstNameOnly(tracking.driverName);
  if (tracking.stopStatus === "IN_PROGRESS") return { kind: "arriving", driverName };

  const window = formatDeliveryWindow(tracking.estimatedArrivalWindow);
  if (tracking.runStatus === "IN_PROGRESS") {
    return { kind: "on-the-way", stopsAhead: tracking.stopsAhead, driverName, window };
  }
  return { kind: "scheduled", scheduledDate: tracking.scheduledDate, driverName, window };
}
