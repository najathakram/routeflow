/**
 * Continuous-scan gate. Camera decoders (expo-camera, BarcodeDetector, zxing)
 * fire the same barcode every frame while it stays in view; this decides which
 * detections count as intentional scans.
 *
 * Rules:
 * - A code different from the last-seen one is accepted immediately (operator
 *   moved to the next item — this is the A→B→A "re-scan the same item" case).
 * - The same code is rejected while it keeps re-appearing within the cooldown
 *   window. The window SLIDES: every rejected detection refreshes `lastAt`, so
 *   holding the camera on one item never re-adds it (frame-spam protection) — the
 *   code must leave the frame for a full `SCAN_COOLDOWN_MS` before a repeat scan
 *   of the SAME item is accepted and increments its qty.
 *
 * The cooldown is the "how long must the barcode be ABSENT to count as an
 * intentional re-present". 1500ms was too long — an operator re-presenting the same
 * item at a natural pace saw the qty NOT go up (desktop's keyboard-wedge scanner has
 * discrete events with no such gap). 700ms is still comfortably above any per-frame
 * decode interval (so a held item can't spam-add) but responsive to a real rescan.
 */
export interface ScanGateState {
  lastCode: string;
  lastAt: number;
}

export const SCAN_COOLDOWN_MS = 700;

export function gateScan(
  code: string,
  state: ScanGateState | null,
  now: number,
  cooldownMs: number = SCAN_COOLDOWN_MS,
): { accept: boolean; state: ScanGateState } {
  const next = { lastCode: code, lastAt: now };
  if (!code.trim()) return { accept: false, state: state ?? next };
  if (!state || state.lastCode !== code || now - state.lastAt >= cooldownMs) {
    return { accept: true, state: next };
  }
  return { accept: false, state: next };
}

/** A call-to-action rendered inside the scanner's feedback pill. */
export interface ScanFeedbackAction {
  label: string;
  onPress: () => void;
}

/** Feedback shown inside the scanner overlay after each continuous scan. */
export interface ScanFeedback {
  kind: "added" | "error";
  text: string;
  /**
   * Renders a button in the pill instead of stranding the operator, and the
   * scanner STAYS OPEN — the action is expected to raise a sheet that stacks
   * above it (see ScanOrderSheet's `paused` prop).
   *
   * Prefer this over `{close:true}`. On react-native-web, Modal portals are
   * appended to document.body at mount with no z-index, so a root-mounted
   * confirm dialog renders BEHIND the opaque scan sheet — which is why the
   * old miss path had to close the scanner to be seen at all, and why the
   * first mis-read stranded the operator.
   */
  action?: ScanFeedbackAction;
}

/**
 * What a continuous `onScanned` handler tells the scanner to do next:
 * show feedback and keep scanning, or close the overlay.
 * `void` = keep scanning, no banner.
 *
 * `close` means "this hand-off REPLACES the scanner" — it is not the way to
 * surface a dialog. No order or invoice path uses it any more; prefer
 * `feedback.action`.
 */
export type ScanOutcome = { close?: boolean; feedback?: ScanFeedback } | void;
