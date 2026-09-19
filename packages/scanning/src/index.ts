/**
 * @routeflow/scanning — the continuous-scan engine shared by apps/mobile and apps/web.
 *
 * - `scan-loop`: the dedupe gate (per-code cooldown + absence clocks, multi-slot LRU) and the
 *   `ScanOutcome`/`ScanFeedback` types every scan handler returns.
 * - `scan-pending-buffer`: bounded FIFO so a detection arriving mid-resolve is queued, not lost.
 * - `scan-engine`: sequences gate then buffer per camera frame / manual entry / settle.
 * - `scan-feedback`: `cueForOutcome` — which accept/reject cue an outcome earns. The sound and
 *   vibration themselves are per-platform side effects and stay in each app's `scan-cue`.
 */
export * from "./scan-loop";
export * from "./scan-pending-buffer";
export * from "./scan-engine";
export * from "./scan-feedback";
