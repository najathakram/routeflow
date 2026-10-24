/**
 * Row 507: the carrier / tracking text of a shipment write, ONE place for the caps and the guard. Used by the
 * order and invoice shipment writes (they share `UpdateShipmentDto`) and by batch "Mark shipped".
 * The text is trimmed (empty = clear), then a CHANGED value that a spreadsheet would run as a formula
 * (`safe-text-cell.ts`, the same guard names, addresses and licences use) is a coded 400
 * TEXT_CELL_FORMULA_LEAD. An echoed stored value never blocks: validation is on write, change-only.
 */
import { assertSafeTextCell } from "../common/safe-text-cell";

/** Caps for the carrier label and the tracking number (the DTO and batch ship read these, never their own). */
export const MAX_SHIPPING_CARRIER = 64;
export const MAX_SHIPPING_TRACKING = 128;

export interface ShipmentTextInput {
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
}

/** The trimmed carrier / tracking (null = clear), after refusing a changed formula-led value. */
export function resolveShipmentText(
  dto: ShipmentTextInput,
  stored?: ShipmentTextInput | null,
): { carrier: string | null; tracking: string | null } {
  const carrier = dto.shippingCarrier?.trim() || null;
  const tracking = dto.shippingTrackingNumber?.trim() || null;
  assertSafeTextCell(
    { shippingCarrier: carrier, shippingTrackingNumber: tracking },
    stored ? { ...stored } : null,
  );
  return { carrier, tracking };
}
