"use client";

import { ConfirmDialog } from "@/components/ConfirmDialog";

/** Asked before staff move an order OFF in-store pickup (ROUTE / SHIP): the order stops being a pickup order. */
export function FulfillPathMoveConfirm({
  open,
  onClose,
  onConfirm,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Move this order off in-store pickup?"
      description="It will no longer be a pickup order."
      confirmLabel="Move order"
      variant="secondary"
      loading={loading}
    />
  );
}
