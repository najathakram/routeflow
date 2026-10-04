"use client";

import * as React from "react";
import { Package } from "lucide-react";
import { carrierLabel, getTrackingUrl } from "@/lib/shipping";
import { shipmentState, type ShipmentState } from "@/lib/buyer-fulfilment";
import { fmtDate } from "@/lib/formatting";

/**
 * Business profiles 1B — "Shipment" on the buyer's order detail, in place of "Track your
 * delivery", for a SHIP order of a configured seller: the carrier and the tracking number, which
 * links to the carrier's own tracking page when the carrier is one `lib/shipping` knows (the URL
 * is always derived, never stored). No route, driver or ETA wording.
 */
export function ShipmentCard({
  order,
}: {
  order: {
    status: string;
    shippedAt?: string | null;
    shippingCarrier?: string | null;
    shippingTrackingNumber?: string | null;
  };
}) {
  const titleId = React.useId();
  const state = shipmentState(order);
  const { headline, detail } = SHIPMENT_COPY[state];
  const carrier = carrierLabel(order.shippingCarrier);
  const number = order.shippingTrackingNumber?.trim() || "";
  const url = getTrackingUrl(order.shippingCarrier, number);
  const shippedOn =
    state === "shipped" && order.shippedAt ? `Shipped ${fmtDate(order.shippedAt)}.` : null;

  return (
    <section
      aria-labelledby={titleId}
      data-testid="shipment-card"
      className="mb-6 rounded-xl border border-surface-border bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-buyer-50 text-buyer-600">
            <Package className="h-4 w-4" aria-hidden="true" />
          </span>
          <h2 id={titleId} className="text-sm font-semibold text-navy">
            Shipment
          </h2>
        </div>
      </div>

      <div className="px-4 py-4">
        <p data-testid="shipment-headline" className="text-lg font-semibold text-navy">
          {headline}
        </p>
        {(shippedOn ?? detail) && (
          <p data-testid="shipment-detail" className="mt-0.5 text-sm text-navy/70">
            {shippedOn ?? detail}
          </p>
        )}
        {(carrier || number) && (
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {carrier && (
              <div className="rounded-lg bg-surface-raised px-3 py-2">
                <dt className="text-xs text-navy/70">Carrier</dt>
                <dd className="text-sm font-medium text-navy">{carrier}</dd>
              </div>
            )}
            {number && (
              <div className="rounded-lg bg-surface-raised px-3 py-2">
                <dt className="text-xs text-navy/70">Tracking number</dt>
                <dd className="break-all text-sm font-medium text-navy">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-buyer-600 underline hover:text-buyer-700"
                    >
                      {number}
                    </a>
                  ) : (
                    number
                  )}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

const SHIPMENT_COPY: Record<ShipmentState, { headline: string; detail: string | null }> = {
  not_shipped: {
    headline: "Not shipped yet",
    detail: "The carrier and tracking number will show here once the seller ships this order.",
  },
  shipped: { headline: "Shipped", detail: "Your order is with the carrier." },
  delivered: { headline: "Delivered", detail: null },
  cancelled: { headline: "Cancelled", detail: null },
};
