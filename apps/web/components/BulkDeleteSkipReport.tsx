"use client";

import * as React from "react";
import { Modal, Button } from "@routeflow/ui/web";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "./dialog-mobile-fit";

/**
 * The products a bulk delete REFUSED (a family that still has active variants, a product with active
 * order items) and why, in a dialog that stays until dismissed - a toast would bury the list. The
 * reasons are the API's own fixed sentences for each refusal (`skipped[].reason`); the rest of the
 * selection was processed, which the dialog says so nobody re-selects it.
 */
export interface SkippedProduct {
  id: string;
  reason: string;
}

export function BulkDeleteSkipReport({
  skipped,
  onClose,
}: {
  skipped: readonly SkippedProduct[];
  onClose: () => void;
}) {
  if (skipped.length === 0) return null;
  const n = skipped.length;
  return (
    <Modal
      open
      onClose={onClose}
      title={`${n} product${n === 1 ? " was" : "s were"} not deleted`}
      className={DIALOG_FIT}
      footer={
        <Button variant="secondary" className={DIALOG_FOOTER_BUTTON} onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="mb-2 text-sm text-navy/70">
        Everything else in your selection was processed. These were left as they are:
      </p>
      <ul className="max-h-64 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-navy">
        {skipped.map((s) => (
          <li key={s.id}>{s.reason}</li>
        ))}
      </ul>
    </Modal>
  );
}
