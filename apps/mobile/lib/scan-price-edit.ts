/**
 * B901 — iOS cannot present a Modal over another Modal (it queues the second
 * until the first dismisses). The scan sheet is itself a Modal, so the
 * price-edit modal must be presented only after the scan sheet has closed, and
 * the scan sheet reopened when the price modal closes.
 */

/** Time for the scan sheet's dismissal animation to finish before presenting the next Modal. */
export const PRICE_MODAL_AFTER_SCAN_CLOSE_MS = 450;

export interface ScanPriceEditPlan {
  closeScan: boolean;
  presentDelayMs: number;
  resumeScanOnClose: boolean;
}

export function planScanPriceEdit(scanOpen: boolean): ScanPriceEditPlan {
  return scanOpen
    ? { closeScan: true, presentDelayMs: PRICE_MODAL_AFTER_SCAN_CLOSE_MS, resumeScanOnClose: true }
    : { closeScan: false, presentDelayMs: 0, resumeScanOnClose: false };
}
