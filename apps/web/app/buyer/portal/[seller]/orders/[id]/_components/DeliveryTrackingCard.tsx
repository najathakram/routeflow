"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Truck } from "lucide-react";
import { Badge, Button, type BadgeVariant } from "@routeflow/ui/web";
import {
  TRACKING_PILL_LABEL,
  deriveTrackingView,
  describeTrackingView,
  isTrackingLive,
  trackingFacts,
  type TrackingView,
  type TrackingViewKind,
} from "@routeflow/types";
import { BUYER_TRACKING_POLL_MS, useBuyerOrderTracking } from "@/lib/api/buyer";

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
          <Badge variant={STATUS_PILL_VARIANT[view.kind]} data-testid="tracking-status">
            {TRACKING_PILL_LABEL[view.kind]}
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
  const { headline, detail } = describeTrackingView(view);
  const facts = trackingFacts(view);
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
// Headline, detail, facts and pill text are shared with mobile (@routeflow/types
// order-tracking-view, #2348); only the web badge tone per state lives here.

const STATUS_PILL_VARIANT: Record<TrackingViewKind, BadgeVariant> = {
  cancelled: "danger",
  delivered: "success",
  unscheduled: "neutral",
  "out-for-delivery": "info",
  "partly-delivered": "warning",
  rescheduling: "warning",
  skipped: "warning",
  "stop-completed": "success",
  "route-finished": "neutral",
  scheduled: "info",
  "on-the-way": "info",
  arriving: "success",
};

function pollCadence(): string {
  const minutes = Math.round(BUYER_TRACKING_POLL_MS / 60_000);
  return minutes === 1 ? "Updates every minute" : `Updates every ${minutes} minutes`;
}
