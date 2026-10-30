import { isTextEntryActive } from "@/lib/refocus-scanner";

/**
 * Row 237 / SA-1059: when the clerk is doing something other than scanning. ONE definition, shared by the digit redirect
 * (the key listener in CounterSaleScreen) and the camera strip's frame check, so the two can never disagree about it.
 */

/** A Radix dialog is open (a price edit, a confirm, the return flow): scans and redirected keys wait for it. */
export function counterDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/**
 * A decoded camera frame must be dropped: focus sits in a text field OTHER than the scan field (a typed tender, a line note,
 * the customer search), or a dialog is open. The scan field itself is the camera's own home, so focus there still counts.
 */
export function cameraFrameBlocked(scanEl: HTMLElement | null): boolean {
  if (isTextEntryActive() && document.activeElement !== scanEl) return true;
  return counterDialogOpen();
}
