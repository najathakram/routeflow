"use client";

import * as React from "react";
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
  // The page clears `path` the moment it confirms, but the dialog stays on screen while it animates closed:
  // hold the last path so the copy does not flip back to the pickup-only sentence mid-close.
  const held = React.useRef(path);
  if (path) held.current = path;
  const shown = path ?? held.current;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Move this order off in-store pickup?"
      description={
        shown === "SHIP"
          ? "It will no longer be a pickup order. It will ship by carrier: add the carrier and tracking number in the Shipment card, then mark it shipped."
          : "It will no longer be a pickup order."
      }
      confirmLabel="Move order"
      variant="secondary"
      loading={loading}
    />
  );
}
