/**
 * @routeflow/scanning — the continuous-scan engine shared by apps/mobile and apps/web.
 *
 * - `scan-loop`: the dedupe gate (per-code cooldown + absence clocks, multi-slot LRU) and the
 *   `ScanOutcome`/`ScanFeedback` types every scan handler returns.
 * - `scan-pending-buffer`: bounded FIFO so a detection arriving mid-resolve is queued, not lost.
 * - `scan-engine`: sequences gate then buffer per camera frame / manual entry / settle.
 *   `continuousFrameScanned` additionally composes the aim-box + steady-read filters below
 *   ahead of the gate, for continuous-mode camera frames specifically (#2131 review round 1).
 * - `scan-feedback`: `cueForOutcome` — which accept/reject cue an outcome earns. The sound and
 *   vibration themselves are per-platform side effects and stay in each app's `scan-cue`.
 * - `aim-box`: DEFAULT-ON center-aim-box containment check, ahead of the gate above.
 * - `steady-read`: DEFAULT-ON same-value-N-frames debounce, ahead of the gate above.
 * - `scan-mode`: OPTIONAL per-device Continuous/Hold-to-scan decode gate, ahead of both.
 */
export * from "./scan-loop";
export * from "./scan-pending-buffer";
export * from "./scan-engine";
export * from "./scan-feedback";
export * from "./barcode-normalize";
export * from "./barcode-symbology";
export * from "./scan-level";
export * from "./aim-box";
export * from "./steady-read";
export * from "./scan-mode";
