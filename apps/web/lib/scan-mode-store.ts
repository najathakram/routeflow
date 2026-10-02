import { SCAN_MODE_STORAGE_KEY, parseScanMode, type ScanMode } from "@routeflow/scanning";

/**
 * Hold-to-scan (owner ruling 2026-09-24): the OPTIONAL per-device scan mode, kept in localStorage under the one shared key.
 * Default Continuous. A storage that throws (private mode, blocked site data) must never break the scanner: reads fall
 * back to Continuous and writes are swallowed.
 */
export function readScanMode(): ScanMode {
  try {
    return parseScanMode(window.localStorage.getItem(SCAN_MODE_STORAGE_KEY));
  } catch {
    return "continuous";
  }
}

export function writeScanMode(mode: ScanMode): void {
  try {
    window.localStorage.setItem(SCAN_MODE_STORAGE_KEY, mode);
  } catch {
    // the choice still applies for this session (component state); it just is not remembered
  }
}
