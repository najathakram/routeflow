"use client";

import * as React from "react";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { CARRIERS, normalizeCarrier } from "@/lib/shipping";
import type { ShipWithTrackingValues } from "@/lib/ship-with-tracking";

/**
 * "Mark shipped" on a carrier (SHIP) order: asks for the carrier + tracking first so the customer gets
 * ONE shipped email that carries it. "Skip, ship now" is the old behaviour. The save-then-ship order
 * lives in `shipWithTracking` (lib), so it is testable without the page. It opens pre-filled with the
 * carrier + tracking number already saved on the order (the operator may have added them earlier).
 */
function initialCarrierId(saved?: string | null): string {
  if (!saved?.trim()) return CARRIERS[0].id;
  // A recognised carrier (id or label) selects its option; a custom courier lands on "Other"
  // instead of silently showing UPS.
  return normalizeCarrier(saved) ?? "other";
}

export function ShipWithTrackingDialog({
  open,
  onClose,
  onShipWithTracking,
  onSkip,
  isPending,
  initialCarrier,
  initialTracking,
}: {
  open: boolean;
  onClose: () => void;
  /** Saves the shipment, then ships. Rejects (dialog stays open) when the save fails. */
  onShipWithTracking: (values: ShipWithTrackingValues) => Promise<void>;
  /** Ships now, without tracking. */
  onSkip: () => void;
  isPending?: boolean;
  /** The carrier + tracking number already saved on the order; read each time the dialog opens. */
  initialCarrier?: string | null;
  initialTracking?: string | null;
}) {
  const [carrier, setCarrier] = React.useState<string>(initialCarrierId(initialCarrier));
  const [tracking, setTracking] = React.useState(initialTracking ?? "");
  const [busy, setBusy] = React.useState(false);
  const carrierId = React.useId();
  const trackingId = React.useId();

  React.useEffect(() => {
    if (open) {
      setCarrier(initialCarrierId(initialCarrier));
      setTracking(initialTracking ?? "");
    }
    // Seed on the open transition only: a background refetch while the operator types must not
    // overwrite what they have typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function shipWith() {
    setBusy(true);
    try {
      await onShipWithTracking({ shippingCarrier: carrier, shippingTrackingNumber: tracking });
      onClose();
    } catch {
      // the caller toasts the failure; the dialog stays open so nothing typed is lost
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add tracking (optional)"
      className="max-w-md"
      footer={
        <>
          <Button
            variant="ghost"
            type="button"
            disabled={busy || isPending}
            onClick={() => {
              onSkip();
              onClose();
            }}
          >
            Skip, ship now
          </Button>
          <Button
            type="button"
            onClick={shipWith}
            loading={busy || isPending}
            disabled={!tracking.trim()}
          >
            Ship with tracking
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={carrierId} className="block text-xs font-medium text-navy/70">
            Carrier
          </label>
          <select
            id={carrierId}
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            className={cn(
              "h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy",
              "focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
            )}
          >
            {CARRIERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={trackingId} className="block text-xs font-medium text-navy/70">
            Tracking number
          </label>
          <input
            id={trackingId}
            type="text"
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="e.g. 1Z999AA10123456784"
            className={cn(
              "h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40",
              "focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
            )}
          />
        </div>
      </div>
    </Modal>
  );
}
