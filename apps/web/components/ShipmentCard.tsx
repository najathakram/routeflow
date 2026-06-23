"use client";

import * as React from "react";
import { Truck, ExternalLink, Pencil } from "lucide-react";
import { Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";
import { CARRIERS, carrierLabel, getTrackingUrl } from "@/lib/shipping";

/**
 * Carrier-shipment card shown on the order + invoice detail pages. Displays the
 * recorded carrier + tracking number with a clickable "Track" link (built from
 * the shared `getTrackingUrl`), and an edit dialog to add / change / clear the
 * shipment. The actual persistence is delegated to `onSave` so the same card
 * works for both the order (`PATCH /orders/:id/shipment`) and invoice
 * (`PATCH /invoices/:id/shipment`) endpoints.
 *
 * Mirrors the Radix Modal + Card design system used across the dashboard.
 */
export interface ShipmentCardProps {
  carrier?: string | null;
  trackingNumber?: string | null;
  shippedAt?: string | null;
  /** Persist a new carrier + tracking number. Empty strings clear the shipment. */
  onSave: (values: { shippingCarrier: string; shippingTrackingNumber: string }) => Promise<unknown>;
  isSaving?: boolean;
  /** Hide the edit affordance (e.g. for non-operator viewers). Defaults to false. */
  readOnly?: boolean;
}

export function ShipmentCard({
  carrier,
  trackingNumber,
  shippedAt,
  onSave,
  isSaving,
  readOnly = false,
}: ShipmentCardProps) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = React.useState(false);
  // Local form state for the dialog. `carrier` defaults to UPS so the select is
  // never blank; the tracking number drives whether a shipment exists at all.
  const [formCarrier, setFormCarrier] = React.useState<string>(carrier || CARRIERS[0].id);
  const [formTracking, setFormTracking] = React.useState<string>(trackingNumber ?? "");

  const hasTracking = !!(trackingNumber && trackingNumber.trim());
  const trackUrl = getTrackingUrl(carrier, trackingNumber);

  function openEdit() {
    setFormCarrier(carrier || CARRIERS[0].id);
    setFormTracking(trackingNumber ?? "");
    setEditOpen(true);
  }

  async function handleSave() {
    const tracking = formTracking.trim();
    try {
      await onSave({
        // Clear the carrier too when the tracking number is removed.
        shippingCarrier: tracking ? formCarrier : "",
        shippingTrackingNumber: tracking,
      });
      setEditOpen(false);
      toast({
        title: tracking ? "Shipment saved" : "Shipment cleared",
        variant: "success",
      });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      toast({
        title: "Could not save shipment",
        description: err?.response?.data?.message || err?.message,
        variant: "error",
      });
    }
  }

  return (
    <>
      <Card title="Shipment">
        {hasTracking ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Truck className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-navy">{carrierLabel(carrier)}</p>
                {trackUrl ? (
                  <a
                    href={trackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 break-all text-sm text-brand-500 hover:underline"
                  >
                    {trackingNumber}
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                ) : (
                  <p className="break-all text-sm text-navy/80">{trackingNumber}</p>
                )}
                {shippedAt && (
                  <p className="mt-0.5 text-xs text-navy/70">
                    Shipped {new Date(shippedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>
            {!readOnly && (
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                leftIcon={<Pencil className="h-4 w-4" />}
                onClick={openEdit}
              >
                Edit shipment
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-navy/70">No carrier shipment recorded.</p>
            {!readOnly && (
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                leftIcon={<Truck className="h-4 w-4" />}
                onClick={openEdit}
              >
                Add tracking
              </Button>
            )}
          </div>
        )}
      </Card>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Shipment tracking"
        description="Record the carrier and tracking number for this shipment."
        className="max-w-md"
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} loading={isSaving}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-navy/70">Carrier</label>
            <select
              value={formCarrier}
              onChange={(e) => setFormCarrier(e.target.value)}
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
            <label className="block text-xs font-medium text-navy/70">Tracking number</label>
            <input
              type="text"
              value={formTracking}
              onChange={(e) => setFormTracking(e.target.value)}
              placeholder="e.g. 1Z999AA10123456784"
              className={cn(
                "h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40",
                "focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              )}
            />
            <p className="text-xs text-navy/50">
              Leave the tracking number empty and save to clear the shipment.
            </p>
          </div>
        </div>
      </Modal>
    </>
  );
}
