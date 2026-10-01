// ─── Order tracking view (#2095 web, #2348 mobile) ─────────────────────────────
//
// The rules and copy behind the buyer's "Track your delivery" card, shared by web and mobile so
// the two can never tell a buyer different things about the same stop. Pure: no React, no
// platform imports. Moved here from web's `delivery-tracking.logic.ts` + `DeliveryTrackingCard`
// (which now import it); web's `delivery-tracking.logic.test.ts` pins it. Client-side only —
// the API may only `import type` from this package (see order-tracking.ts).

import type { OrderTracking } from "./order-tracking";

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

export type TrackingViewKind = TrackingView["kind"];

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

/** The card's status pill text per state. Each platform maps the kind to its own badge tone. */
export const TRACKING_PILL_LABEL: Record<TrackingViewKind, string> = {
  cancelled: "Cancelled",
  delivered: "Delivered",
  unscheduled: "Not scheduled",
  "out-for-delivery": "Out for delivery",
  "partly-delivered": "Partly delivered",
  rescheduling: "Rescheduling",
  skipped: "Stop skipped",
  "stop-completed": "Stop completed",
  "route-finished": "Route finished",
  scheduled: "Scheduled",
  "on-the-way": "On the way",
  arriving: "Arriving",
};

/** The run's calendar day (stored as UTC midnight), e.g. "Tue, Sep 29". */
export function trackingCalendarDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** A real delivery timestamp in the viewer's own time, e.g. "Sep 24, 2026 at 2:14 PM". */
export function trackingDeliveredOn(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** The card's headline + one-line detail per state. */
export function describeTrackingView(view: TrackingView): { headline: string; detail: string } {
  switch (view.kind) {
    case "cancelled":
      return { headline: "This order was cancelled", detail: "There's no delivery to track." };
    case "delivered":
      return {
        headline: "Delivered",
        detail: view.deliveredAt
          ? `Delivered on ${trackingDeliveredOn(view.deliveredAt)}.`
          : "Your order has been delivered.",
      };
    case "unscheduled":
      return {
        headline: "Not scheduled yet",
        detail:
          "Your driver and delivery window will show here once this order is on a delivery route.",
      };
    case "out-for-delivery":
      return {
        headline: "Out for delivery",
        detail: "Your order is on its way. Live stop updates aren't available for this delivery.",
      };
    case "partly-delivered":
      return {
        headline: "Partly delivered",
        detail:
          "Part of this order has been delivered. The rest will show here once it's on a delivery route.",
      };
    case "rescheduling":
      return {
        headline: "Being rescheduled",
        detail: "This delivery run was called off. Your seller will reschedule your order.",
      };
    case "skipped":
      return {
        headline: "Stop skipped",
        detail: "Your stop was skipped on this run. Your seller will follow up to reschedule.",
      };
    case "stop-completed":
      return { headline: "Stop completed", detail: "Your driver has completed your stop." };
    case "route-finished":
      return {
        headline: "Route finished",
        detail:
          "This delivery route has finished. Contact your seller if your order hasn't arrived.",
      };
    case "scheduled":
      return { headline: "Scheduled for delivery", detail: "Your order is on a delivery route." };
    case "on-the-way":
      return {
        headline: stopsBeforeYouLabel(view.stopsAhead),
        detail: view.driverName
          ? `${view.driverName} is on the way.`
          : "Your driver is on the way.",
      };
    case "arriving":
      return {
        headline: "Your driver has arrived",
        detail: view.driverName
          ? `${view.driverName} is at your stop now.`
          : "Your driver is at your stop now.",
      };
  }
}

/** The label/value facts shown under the headline (date, driver, window) for live states. */
export function trackingFacts(view: TrackingView): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (view.kind === "scheduled") {
    facts.push({ label: "Delivery date", value: trackingCalendarDay(view.scheduledDate) });
  }
  if (view.kind === "scheduled" || view.kind === "on-the-way" || view.kind === "arriving") {
    if (view.driverName) facts.push({ label: "Driver", value: view.driverName });
  }
  if ((view.kind === "scheduled" || view.kind === "on-the-way") && view.window) {
    facts.push({ label: "Delivery window", value: view.window });
  }
  return facts;
}
