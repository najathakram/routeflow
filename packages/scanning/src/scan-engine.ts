/**
 * F30 / REG-B192 shipped the fix for ScanCamera.tsx's drop-not-queue mutex —
 * a pure gate (`scan-loop.ts`) ahead of a pure pending buffer
 * (`scan-pending-buffer.ts`) so a detection arriving mid-resolve is buffered
 * instead of lost. `ScanCamera.web.tsx` was deliberately left out of that
 * batch and still carries three defects the native rewrite removed
 * (REG-B202):
 *
 *   1. DECODE STARVATION — the web decode loop awaited the FULL resolve
 *      (`fire(code)`, which itself awaits `onScanned`) before releasing its
 *      in-flight guard, so no frame was even decoded while a scan resolved.
 *      Wiring in the buffer fixes nothing if the buffer is never offered a
 *      code to begin with.
 *   2. DROP-NOT-QUEUE — `fire()` bailed on a `busyRef` boolean BEFORE
 *      reaching the gate at all, discarding anything that did arrive with
 *      zero feedback — the same defect REG-B192 already fixed on native.
 *   3. LEGACY RE-ANCHOR — the web `finally` block wrote
 *      `gateRef.current = { lastCode, lastAt: Date.now() }` on every settle,
 *      pinning the gate to the old single-slot shape and defeating
 *      `scan-loop.ts`'s multi-slot per-code cooldown tracking.
 *
 * This module is the sequencing SEAM the web adapter is rewired through: one
 * call into `scan-loop.ts`'s gate, then one into
 * `scan-pending-buffer.ts`'s buffer, per event — and no policy of its own:
 * no dedupe (the gate's job), no capping (the buffer's job), no
 * `Date.now()` (the caller's clock, injected as `now`). Keeping it
 * platform-free means the web component's decode loop and resolve chain stay
 * thin, and this file's own logic — the only NEW logic REG-B202 adds — unit
 * tests in the plain node Jest env, the same way `scan-ladder.ts` does.
 */
import { gateScan, type ScanCandidates, type ScanGateState } from "./scan-loop";
import {
  completeResolve,
  createPendingBuffer,
  pushScan,
  type PendingBufferState,
} from "./scan-pending-buffer";

export interface ScanEngineState {
  gate: ScanGateState | null;
  buffer: PendingBufferState;
}

export interface ScanEngineStep {
  next: ScanEngineState;
  /** The code to hand to the resolver right now, or null to start nothing. */
  startResolving: string | null;
  /**
   * The buffer's `isResolving` edge crossed by this step: "on" idle→resolving,
   * "off" resolving→idle, null when there is no edge.
   */
  indicator: "on" | "off" | null;
}

/** The empty/idle engine — no code ever tracked, buffer at rest. */
export function createScanEngine(): ScanEngineState {
  return { gate: null, buffer: createPendingBuffer() };
}

/** "on" idle→resolving, "off" resolving→idle, null when there is no edge. */
function indicatorEdge(before: boolean, after: boolean): "on" | "off" | null {
  if (before === after) return null;
  return after ? "on" : "off";
}

/**
 * A camera frame decoded `code` at `now`. Gate FIRST, then buffer — the gate
 * always runs and its resulting state is always kept (even on reject; see
 * the frozen-clock regression test), because it is what lets a rejected
 * repeat's `lastSeenAt` keep moving while a resolve is in flight.
 */
export function frameScanned(
  state: ScanEngineState,
  code: string,
  now: number,
  candidatesOf?: ScanCandidates,
): ScanEngineStep {
  const gated = gateScan(code, state.gate, now, undefined, candidatesOf);
  if (!gated.accept) {
    return { next: { ...state, gate: gated.state }, startResolving: null, indicator: null };
  }
  const wasResolving = state.buffer.isResolving;
  const result = pushScan(state.buffer, code);
  return {
    next: { gate: gated.state, buffer: result.next },
    startResolving: result.startResolving,
    indicator: indicatorEdge(wasResolving, result.next.isResolving),
  };
}

/**
 * A deliberate manual submit: SKIPS the gate entirely (no cooldown, no
 * absence gap — this is per-definition intentional) but STILL goes through
 * the buffer, so a manual entry mid-resolve is queued instead of dropped
 * (the W3 fix: the old web `fire(code, true)` bypassed the gate but still
 * fell through the same `busyRef` drop as a camera frame).
 */
export function manualScanned(state: ScanEngineState, code: string): ScanEngineStep {
  const wasResolving = state.buffer.isResolving;
  const result = pushScan(state.buffer, code);
  return {
    next: { ...state, buffer: result.next },
    startResolving: result.startResolving,
    indicator: indicatorEdge(wasResolving, result.next.isResolving),
  };
}

/** The in-flight resolve settled — drain whatever the buffer queued. */
export function scanSettled(state: ScanEngineState): ScanEngineStep {
  const wasResolving = state.buffer.isResolving;
  const result = completeResolve(state.buffer);
  return {
    next: { ...state, buffer: result.next },
    startResolving: result.startResolving,
    indicator: indicatorEdge(wasResolving, result.next.isResolving),
  };
}
