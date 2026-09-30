/**
 * The continuous-scan gate now lives in `@routeflow/scanning` (one source shared with apps/web).
 * This file keeps every existing `../lib/scan-loop` import path working and does the ONE thing the
 * shared gate deliberately does not: injects `normalizeScanCode`, because mobile has two decoders
 * that can disagree within a session (native vs BarcodeDetector/zxing — an iOS 13-digit decode and
 * a 12-digit decode of the same UPC-A must be one item). Behaviour is identical to the
 * pre-extraction gate; `__tests__/scan-loop.test.ts` pins that against this wrapper.
 */
import { gateScan as gateScanShared, SCAN_COOLDOWN_MS } from "@routeflow/scanning";
import type { ScanGateState } from "@routeflow/scanning";
import { normalizeScanCode } from "./barcode-normalize";

export { ABSENCE_GAP_MS, SCAN_COOLDOWN_MS, SCAN_SLOTS } from "@routeflow/scanning";
export type {
  ScanCandidates,
  ScanFeedback,
  ScanFeedbackAction,
  ScanGateState,
  ScanOutcome,
  ScanSlot,
} from "@routeflow/scanning";

export function gateScan(
  code: string,
  state: ScanGateState | null,
  now: number,
  cooldownMs: number = SCAN_COOLDOWN_MS,
): { accept: boolean; state: ScanGateState } {
  return gateScanShared(code, state, now, cooldownMs, normalizeScanCode);
}
