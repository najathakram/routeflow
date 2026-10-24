"use client";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { UNMARK_FINAL_INVOICE_COPY } from "@/lib/unmark-shipped";

/** Confirm before "Unmark shipped" on an order whose invoice was issued as final. */
export function UnmarkShippedConfirm({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Unmark shipped"
      description={UNMARK_FINAL_INVOICE_COPY}
      confirmLabel="Continue"
      variant="secondary"
    />
  );
}
