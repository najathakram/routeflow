/**
 * B901 — iOS cannot present a Modal over another Modal (it queues the second
 * until the first dismisses). The scan sheet is itself a Modal, so the
 * price-edit modal must be presented only after the scan sheet has closed, and
 * the scan sheet reopened when the price modal closes.
 *
 * iOS: present from the scan Modal's `onDismiss` (fires once the sheet has
 * fully closed — no timing guess). Other platforms: Modal `onDismiss` does not
 * fire, so a timer is used instead.
 */

/** Android has no Modal onDismiss, so this timer is the fallback only (never used on iOS). */
export const SCAN_CLOSE_FALLBACK_MS = 450;

export interface ScanPriceEditPlan {
  closeScan: boolean;
  present: "now" | "onDismiss" | "timer";
  fallbackDelayMs: number;
  resumeScanOnClose: boolean;
}

export function planScanPriceEdit(scanOpen: boolean, platform: string): ScanPriceEditPlan {
  if (!scanOpen) {
    return { closeScan: false, present: "now", fallbackDelayMs: 0, resumeScanOnClose: false };
  }
  if (platform === "ios") {
    return { closeScan: true, present: "onDismiss", fallbackDelayMs: 0, resumeScanOnClose: true };
  }
  return {
    closeScan: true,
    present: "timer",
    fallbackDelayMs: SCAN_CLOSE_FALLBACK_MS,
    resumeScanOnClose: true,
  };
}
