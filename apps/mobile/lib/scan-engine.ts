/**
 * The gate → buffer sequencing seam now lives in `@routeflow/scanning` (one source shared with
 * apps/web). This file keeps every existing `../lib/scan-engine` import path working and injects
 * mobile's `normalizeScanCode` into the per-frame gate — see `./scan-loop` for why.
 */
import { frameScanned as frameScannedShared } from "@routeflow/scanning";
import type { ScanEngineState, ScanEngineStep } from "@routeflow/scanning";
import { normalizeScanCode } from "./barcode-normalize";

export { createScanEngine, manualScanned, scanSettled } from "@routeflow/scanning";
export type { ScanEngineState, ScanEngineStep } from "@routeflow/scanning";

export function frameScanned(state: ScanEngineState, code: string, now: number): ScanEngineStep {
  return frameScannedShared(state, code, now, normalizeScanCode);
}
