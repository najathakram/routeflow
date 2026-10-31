import { isTextEntryActive } from "@/lib/refocus-scanner";

/**
 * Row 237 / SA-1059: when the clerk is doing something other than scanning. ONE definition, shared by the digit redirect
 * (the key listener in CounterSaleScreen) and the camera strip's frame check, so the two can never disagree about it.
 */

/**
 * W-1042: a window that is not a dialog role holds the scan with `data-scan-pause` (the new-item window: it also sits inside
 * the order builder's Radix Modal, where a nested role would break the Unit and Category lists).
 */
export function scanPauseHeld(): boolean {
  return document.querySelector("[data-scan-pause]") !== null;
}

/** A Radix dialog is open (a price edit, a confirm, the return flow), or a scan pause is held: scans and redirected keys wait. */
export function counterDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null || scanPauseHeld();
}

/**
 * A decoded camera frame must be dropped: focus sits in a text field OTHER than the scan field (a typed tender, a line note,
 * the customer search), or a dialog is open. The scan field itself is the camera's own home, so focus there still counts.
 */
export function cameraFrameBlocked(scanEl: HTMLElement | null): boolean {
  if (isTextEntryActive() && document.activeElement !== scanEl) return true;
  if (counterDialogOpen()) return true;
  // W-1042 14b: a menu or popover (the phone menu drawer, AnchoredPopover) is a dialog with no `data-state`. The camera stops
  // for any dialog that is not closed; `counterDialogOpen()` stays narrow because the key listener shares it.
  return document.querySelector('[role="dialog"]:not([data-state="closed"])') !== null;
}
