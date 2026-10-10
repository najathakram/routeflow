"use client";

import * as React from "react";
import { Modal, Button, Badge } from "@routeflow/ui/web";
import { useUpdateStopStatus, type RouteRunStop } from "@/lib/api/routes";
import { DRIVER_APP_LOGIN_URL } from "@/lib/driver-app-link";

/** Apple Maps on iOS/iPadOS, Google Maps everywhere else — mirrors the native
 *  app's openInMaps.ts choice of provider (see apps/mobile/components/openInMaps.ts). */
function isApplePhoneOrTablet(): boolean {
  return typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/** Builds a maps search URL for a stop. Prefers "Business Name, Address" so the
 *  maps app matches the real place listing, same preference order as the
 *  native app's stopToWaypoint/openInMaps. Returns null with nothing to search. */
function stopMapsUrl(stop: RouteRunStop): string | null {
  const address = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
    : undefined;
  const label = stop.customer?.businessName;
  const query = address ? (label ? `${label}, ${address}` : address) : label;
  if (!query) return null;
  return isApplePhoneOrTablet()
    ? `http://maps.apple.com/?q=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function orderStatusBadge(status: string) {
  if (status === "DELIVERED") return <Badge status="COMPLETED" />;
  if (status === "CANCELLED") return <Badge status="CANCELLED" />;
  if (status === "OUT_FOR_DELIVERY") return <Badge status="IN_PROGRESS" />;
  return <Badge status="SCHEDULED" />;
}

export interface StopSheetProps {
  /** null closes the sheet — Modal's own open/onClose stays in sync with this. */
  stop: RouteRunStop | null;
  runId: string | null;
  onClose: () => void;
}

/**
 * PHASE 1a: tapping a stop in the drive-mode field layout opens this sheet —
 * customer/address/order lines READ-ONLY, plus Navigate/Call/Start/Skip.
 * Money-collecting completion ("Delivered in full" / "Refused" / "Collect") is
 * PHASE 1b (Lane F, SA-129) — the disabled slot below links out to the
 * installed driver app instead, which already has 1b's full flow.
 */
export function StopSheet({ stop, runId, onClose }: StopSheetProps) {
  const updateStatus = useUpdateStopStatus();

  const mapsUrl = stop ? stopMapsUrl(stop) : null;
  const phone = stop?.customer?.phone?.trim();
  const orders = stop?.orders ?? [];

  const handleStart = () => {
    if (!stop || !runId) return;
    updateStatus.mutate({ runId, stopId: stop.id, status: "IN_PROGRESS" }, { onSuccess: onClose });
  };

  const handleSkip = () => {
    if (!stop || !runId) return;
    if (!window.confirm(`Skip the stop at ${stop.customer?.businessName ?? "this address"}?`))
      return;
    updateStatus.mutate({ runId, stopId: stop.id, status: "SKIPPED" }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={!!stop}
      onClose={onClose}
      title={stop?.customer?.businessName ?? "Stop"}
      description={
        stop?.customerAddress
          ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
          : undefined
      }
      scroll
      footer={
        <div className="flex w-full flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              disabled={!mapsUrl}
              onClick={() => mapsUrl && window.open(mapsUrl, "_blank", "noopener,noreferrer")}
            >
              Navigate
            </Button>
            <Button variant="secondary" href={phone ? `tel:${phone}` : undefined} disabled={!phone}>
              Call
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              onClick={handleStart}
              loading={updateStatus.isPending && updateStatus.variables?.status === "IN_PROGRESS"}
              disabled={stop?.status !== "PENDING" || updateStatus.isPending}
            >
              Start stop
            </Button>
            <Button
              variant="danger"
              onClick={handleSkip}
              loading={updateStatus.isPending && updateStatus.variables?.status === "SKIPPED"}
              disabled={
                stop?.status === "COMPLETED" || stop?.status === "SKIPPED" || updateStatus.isPending
              }
            >
              Skip
            </Button>
          </div>
          {/* PHASE 1b placeholder (Lane F, SA-129) — money-collecting completion
              isn't built here yet; the driver app already has the full flow. */}
          <Button
            variant="secondary"
            disabled
            title="Coming soon — finish in the driver app for now"
          >
            Delivered / Refused / Collect payment
          </Button>
          <Button variant="link" href={DRIVER_APP_LOGIN_URL} size="sm">
            Finish in the app →
          </Button>
        </div>
      }
    >
      {orders.length > 0 ? (
        <ul className="divide-y divide-surface-border">
          {orders.map((order) => (
            <li key={order.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-sm font-medium text-navy">{order.orderNumber}</span>
              {orderStatusBadge(order.status)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-navy/70">No orders on this stop.</p>
      )}
    </Modal>
  );
}
