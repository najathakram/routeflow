"use client";

import { ConfirmDialog } from "@/components/ConfirmDialog";

/** Asked before staff move an order OFF in-store pickup (ROUTE / SHIP): the order stops being a pickup order. */
export function FulfillPathMoveConfirm({
  open,
  onClose,
  onConfirm,
  loading,
  path,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  /** Where it is going: SHIP says it becomes a carrier shipment (carrier + tracking), the rest the old copy. */
  path?: "ROUTE" | "SHIP" | null;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Move this order off in-store pickup?"
      description={
        path === "SHIP"
          ? "It will no longer be a pickup order. It will ship by carrier: add the carrier and tracking number in the Shipment card, then mark it shipped."
          : "It will no longer be a pickup order."
      }
      confirmLabel="Move order"
      variant="secondary"
      loading={loading}
    />
  );
}
