"use client";

import * as React from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { useDeleteProductFlow } from "./useDeleteProductFlow";

/**
 * The "Delete product?" confirm. It stays open (confirm button loading) while the DELETE is in
 * flight so a second click cannot send a second one; it closes on success or when the family
 * cascade prompt takes over, and stays open on any other failure (the flow already toasted).
 */
export function DeleteProductConfirm({
  id,
  name,
  open,
  onClose,
  flow,
}: {
  id: string;
  name: string;
  open: boolean;
  onClose: () => void;
  flow: ReturnType<typeof useDeleteProductFlow>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={() => {
        if (!flow.isPending) onClose();
      }}
      onConfirm={() => {
        if (flow.isPending) return;
        flow.start(id, {
          onSettled: (outcome) => {
            if (outcome !== "failed") onClose();
          },
        });
      }}
      title="Delete product?"
      description={`${name} will be deactivated and hidden from the catalog. Existing order and invoice history is preserved. Products with an in-flight (undelivered) order cannot be deleted.`}
      confirmLabel="Yes, delete"
      variant="danger"
      loading={flow.isPending}
    />
  );
}
