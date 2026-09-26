"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Truck } from "lucide-react";
import { Badge, Button, type BadgeVariant } from "@routeflow/ui/web";
import { isTrackingLive } from "@routeflow/types";
import { BUYER_TRACKING_POLL_MS, useBuyerOrderTracking } from "@/lib/api/buyer";
import {
  deriveTrackingView,
  stopsBeforeYouLabel,
  type TrackingView,
} from "./delivery-tracking.logic";

/**
 * #2095 — "Track your delivery" on the buyer's order detail: where the order stands on its
 * route, the driver's first name, how many stops come before this one and the delivery window.
 * Only ever this order's own facts: other stops are a count, never a name or an address.
 */
export function DeliveryTrackingCard({
  order,
}: {
  order: { id: string; status: string; deliveredAt?: string | null };
}) {
  const titleId = React.useId();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useBuyerOrderTracking(order.id);

  // The poll carries the order's status too: when it moves ahead of the order detail on screen
  // (the driver just delivered it), refresh the detail so the timeline and lines move with it.
  const trackedStatus = data?.status;
  React.useEffect(() => {
    if (trackedStatus && trackedStatus !== order.status) {
      void qc.invalidateQueries({ queryKey: ["buyer", "order", order.id], exact: true });
    }
  }, [trackedStatus, order.status, order.id, qc]);

  const status = data?.status ?? order.status;
  const view = deriveTrackingView({
    status,
    deliveredAt: order.deliveredAt,
    tracking: data?.tracking ?? null,
  });
  // A delivered or cancelled order needs nothing from the tracking read to say so.
  const decidedByOrder = status === "DELIVERED" || status === "CANCELLED";
  const waiting = !data && !decidedByOrder;

  return (
    <section
      aria-labelledby={titleId}
      data-testid="delivery-tracking"
      className="mb-6 rounded-xl border border-surface-border bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-buyer-50 text-buyer-600">
            <Truck className="h-4 w-4" aria-hidden="true" />
          </span>
          <h2 id={titleId} className="text-sm font-semibold text-navy">
            Track your delivery
          </h2>
        </div>
        {!waiting && (
          <Badge variant={STATUS_PILL[view.kind].variant} data-testid="tracking-status">
            {STATUS_PILL[view.kind].label}
          </Badge>
        )}
      </div>

      <div className="px-4 py-4">
        {waiting && isError ? (
          <div data-testid="tracking-error" className="flex flex-wrap items-center gap-3">
            <p className="flex items-center gap-2 text-sm text-navy/70">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
              Live tracking isn&apos;t available right now.
            </p>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : waiting && isLoading ? (
          <div data-testid="tracking-loading" role="status" className="space-y-2">
            <span className="sr-only">Loading delivery tracking</span>
            <div className="h-5 w-40 animate-pulse rounded bg-surface-raised" />
            <div className="h-4 w-64 max-w-full animate-pulse rounded bg-surface-raised" />
          </div>
        ) : (
          <TrackingBody view={view} live={isTrackingLive(data)} />
        )}
      </div>
    </section>
  );
}

function TrackingBody({ view, live }: { view: TrackingView; live: boolean }) {
  const { headline, detail } = describeView(view);
  const facts = factsOf(view);
  return (
    <>
      <p
        data-testid="tracking-headline"
        aria-live="polite"
        className="text-lg font-semibold text-navy"
      >
        {headline}
      </p>
      <p data-testid="tracking-detail" className="mt-0.5 text-sm text-navy/70">
        {detail}
      </p>
      {facts.length > 0 && (
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label} className="rounded-lg bg-surface-raised px-3 py-2">
              <dt className="text-xs text-navy/70">{f.label}</dt>
              <dd className="text-sm font-medium text-navy">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {live && (
        <p
          data-testid="tracking-live"
          className="mt-3 flex items-center gap-1.5 text-xs text-navy/60"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          {pollCadence()}
        </p>
      )}
    </>
  );
}

// ─── Copy ───────────────────────────────────────────────────────────────────────

const STATUS_PILL: Record<TrackingView["kind"], { label: string; variant: BadgeVariant }> = {
  cancelled: { label: "Cancelled", variant: "danger" },
  delivered: { label: "Delivered", variant: "success" },
  unscheduled: { label: "Not scheduled", variant: "neutral" },
  "out-for-delivery": { label: "Out for delivery", variant: "info" },
  "partly-delivered": { label: "Partly delivered", variant: "warning" },
  rescheduling: { label: "Rescheduling", variant: "warning" },
  skipped: { label: "Stop skipped", variant: "warning" },
  "stop-completed": { label: "Stop completed", variant: "success" },
  "route-finished": { label: "Route finished", variant: "neutral" },
  scheduled: { label: "Scheduled", variant: "info" },
  "on-the-way": { label: "On the way", variant: "info" },
  arriving: { label: "Arriving", variant: "success" },
};

function describeView(view: TrackingView): { headline: string; detail: string } {
  switch (view.kind) {
    case "cancelled":
      return { headline: "This order was cancelled", detail: "There's no delivery to track." };
    case "delivered":
      return {
        headline: "Delivered",
        detail: view.deliveredAt
          ? `Delivered on ${deliveredOn(view.deliveredAt)}.`
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

function factsOf(view: TrackingView): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (view.kind === "scheduled") {
    facts.push({ label: "Delivery date", value: calendarDay(view.scheduledDate) });
  }
  if (view.kind === "scheduled" || view.kind === "on-the-way" || view.kind === "arriving") {
    if (view.driverName) facts.push({ label: "Driver", value: view.driverName });
  }
  if ((view.kind === "scheduled" || view.kind === "on-the-way") && view.window) {
    facts.push({ label: "Delivery window", value: view.window });
  }
  return facts;
}

/** The run's calendar day (stored as UTC midnight), e.g. "Tue, Sep 29". */
function calendarDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** A real delivery timestamp in the viewer's own time, e.g. "Sep 24, 2026 at 2:14 PM". */
function deliveredOn(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

function pollCadence(): string {
  const minutes = Math.round(BUYER_TRACKING_POLL_MS / 60_000);
  return minutes === 1 ? "Updates every minute" : `Updates every ${minutes} minutes`;
}
