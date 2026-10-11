"use client";

import * as React from "react";
import { Modal, Button } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "./dialog-mobile-fit";

/**
 * The products a bulk delete REFUSED (a family that still has active variants, a product with active
 * order items) and why, in a dialog that stays until dismissed - a toast would bury the list. The
 * lines are FIXED copy keyed by the API's machine `skipped[].code` - the server's `reason` text is never
 * rendered; an unknown or missing code gets one neutral line. The rest of the selection was processed,
 * which the dialog says so nobody re-selects it.
 */
export interface SkippedProduct {
  id: string;
  /** Machine code for why the product was refused (see API_ERROR_CODES). */
  code?: string;
  /** Legacy server sentence; kept on the type but never shown. */
  reason?: string;
}

const SKIP_COPY: Readonly<Record<string, string>> = {
  [API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS]:
    "This product still has active variants. Delete or archive its variants first.",
  [API_ERROR_CODES.PRODUCT_HAS_ACTIVE_ORDER_ITEMS]:
    "This product has active order items and cannot be deleted.",
};
const SKIP_FALLBACK = "This product could not be deleted.";

export function skipCopy(code: string | undefined): string {
  return (
    (code !== undefined && Object.hasOwn(SKIP_COPY, code) ? SKIP_COPY[code] : undefined) ??
    SKIP_FALLBACK
  );
}

export function BulkDeleteSkipReport({
  skipped,
  onClose,
  nameById,
}: {
  skipped: readonly SkippedProduct[];
  onClose: () => void;
  /** Product names from the selection the page already holds; an unknown id reads "A product". */
  nameById?: ReadonlyMap<string, string>;
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
          <li key={s.id}>
            <span className="font-medium">{nameById?.get(s.id) || "A product"}</span> -{" "}
            {skipCopy(s.code)}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
