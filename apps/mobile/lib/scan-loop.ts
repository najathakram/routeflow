/**
 * Continuous-scan gate. Camera decoders (expo-camera, BarcodeDetector, zxing)
 * fire the same barcode every frame while it stays in view; this decides which
 * detections count as intentional scans.
 *
 * Rules:
 * - A code different from the last-seen one is accepted immediately (operator
 *   moved to the next item).
 * - The same code is rejected while it keeps re-appearing within the cooldown
 *   window. The window SLIDES: every rejected detection refreshes `lastAt`,
 *   so holding the camera on one item never re-adds it — the code must leave
 *   the frame for a full cooldown before a repeat scan is accepted.
 */
export interface ScanGateState {
  lastCode: string;
  lastAt: number;
}

export const SCAN_COOLDOWN_MS = 1500;

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

/** Feedback shown inside the scanner overlay after each continuous scan. */
export interface ScanFeedback {
  kind: "added" | "error";
  text: string;
}

/**
 * What a continuous `onScanned` handler tells the scanner to do next:
 * show feedback and keep scanning, or close the overlay (e.g. to hand off
 * to a "create this product?" dialog). `void` = keep scanning, no banner.
 */
export type ScanOutcome = { close?: boolean; feedback?: ScanFeedback } | void;
