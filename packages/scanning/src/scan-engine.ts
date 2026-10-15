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
import {
  ABSENCE_GAP_MS,
  gateScan,
  hasBeenAccepted,
  isAbsentFromGate,
  isTrackedByGate,
  STEADY_ABSENCE_GAP_MS,
  touchSeen,
  type ScanCandidates,
  type ScanGateState,
} from "./scan-loop";
import {
  completeResolve,
  createPendingBuffer,
  pushScan,
  type PendingBufferState,
} from "./scan-pending-buffer";
import { isWithinAimBox, type AimBoxRect, type BarcodeBoundsLike } from "./aim-box";
import {
  clearAfterAbsence,
  createSteadyReadState,
  trackSteadyRead,
  type SteadyReadState,
} from "./steady-read";

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
  /** True when this step's accepted scan found the pending buffer full and was NOT queued: surface it. */
  dropped?: boolean;
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
    ...(result.dropped && { dropped: true }),
  };
}

/**
 * A deliberate manual submit: SKIPS the gate entirely (no cooldown, no
 * absence gap — this is per-definition intentional) but STILL goes through
 * the buffer, so a manual entry mid-resolve is queued instead of dropped
 * (the W3 fix: the old web `fire(code, true)` bypassed the gate but still
 * fell through the same `busyRef` drop as a camera frame).
 */
/** Generic over the caller's own state shape (plain `ScanEngineState`, or a `ContinuousScanState` with its `steady` field). */
export function manualScanned<S extends ScanEngineState>(
  state: S,
  code: string,
): ScanEngineStep & { next: S } {
  const wasResolving = state.buffer.isResolving;
  const result = pushScan(state.buffer, code);
  return {
    next: { ...state, buffer: result.next },
    startResolving: result.startResolving,
    indicator: indicatorEdge(wasResolving, result.next.isResolving),
    ...(result.dropped && { dropped: true }),
  };
}

// ─── Continuous-mode camera filters (owner ruling 2026-09-24, #2131 review round 1) ───

export interface ContinuousScanState extends ScanEngineState {
  steady: SteadyReadState;
}

/** The empty/idle continuous-scan engine — gate, buffer and steady-read all at rest. */
export function createContinuousScanState(): ContinuousScanState {
  return { ...createScanEngine(), steady: createSteadyReadState() };
}

export interface ContinuousFrameOptions {
  /** expo-camera's own per-detection geometry, when it reported any. */
  bounds?: BarcodeBoundsLike | null;
  /**
   * The rect a frame's `bounds` center must fall inside to be a candidate scan at all.
   * OMITTED (not merely a wide default) means NO aim-box filtering — a host that draws no
   * visible box (e.g. `ScanOrderSheet`, pending #2059) must never enforce an invisible
   * one; only a host that actually draws a box should pass the EXACT rect it draws
   * (#2131 review point 3 — a caller-computed default that doesn't match what's on
   * screen silently rejects scans the operator can see are correctly aligned).
   */
  aimBox?: AimBoxRect | null;
  candidatesOf?: ScanCandidates;
  /**
   * ORDER BUILDER ONLY (owner ruling 2026-10-14): a repeat of a code the gate has already accepted counts
   * after `FAST_REPEAT_ABSENCE_GAP_MS` out of view with NO steady-hold requirement, so a scan-a-case-a-second
   * rhythm is not eaten by the 800 ms absence + 3-frame hold. The first sighting of a code still needs the
   * steady read. A continuous hold does not re-count while decodes stay under that gap apart (its `lastSeenAt`
   * keeps moving); a decode PAUSE of 0.3 s or more on a held item (blur, glare) reads as a lift-and-re-present and
   * counts again - the accepted cost of the 0.3 s ruling. Default off: every other scan screen stays on the 09-24 rule.
   */
  fastRepeat?: boolean;
}

/** The absence that makes a repeat of the code just accepted a new scan on the order builder. */
export const FAST_REPEAT_ABSENCE_GAP_MS = ABSENCE_GAP_MS;
/** ...and the cooldown for such a repeat equals the absence: a 0.5 s scan rhythm must not lose every other scan. */
export const FAST_REPEAT_COOLDOWN_MS = ABSENCE_GAP_MS;

/**
 * A continuous-mode camera frame decoded `code` at `now` — composes the aim box,
 * steady-read and dedupe gate filters ahead of the buffer, in that order:
 *
 *  1. Aim box (if given): a frame whose center falls outside it is not a candidate scan.
 *     For a code the gate does not track it is pure noise — nothing moves. For a code the
 *     gate ALREADY tracks it still `touchSeen`s: the item is in view, just off-centre, so
 *     drifting out of the box and back is not an absence (#2131 @1f8b1ea4 review, MED).
 *  2. Steady-read: tracks this code's own hold streak. Not yet steady ⇒ this frame is
 *     "seen" (see `touchSeen`) so the gate's `lastSeenAt` clock stays fresh while the
 *     streak fills, but `lastAcceptAt` is left untouched — nothing is accepted yet.
 *  3. Only once steady does the REAL dedupe gate run (`gateScan`) and, on accept, push
 *     to the buffer — a genuinely new item is accepted once, a continuously held one
 *     never re-accepts because its `lastSeenAt` never goes stale (step 2 keeps refreshing
 *     it every frame the code stays in view), and a deliberate re-present still clears
 *     once the code has ACTUALLY left frame for `STEADY_ABSENCE_GAP_MS`: that absence is read off
 *     the gate on the frame that restarts the streak — before its own `touchSeen` — and
 *     marked on the streak, so the ramp-up frames' touches cannot erase it; the steady
 *     frame honours the mark once (#2131 @1f8b1ea4 review, HIGH).
 *
 * This is the ONE place all three concerns compose — see steady-read.ts's own doc for
 * the two failure modes (a held code's own dedupe clock going stale, a slow decoder's
 * reads never fitting a fixed window) this ordering and the touch-vs-accept split fix.
 */
export function continuousFrameScanned(
  state: ContinuousScanState,
  code: string,
  now: number,
  opts: ContinuousFrameOptions = {},
): ScanEngineStep & { next: ContinuousScanState } {
  if (opts.aimBox && !isWithinAimBox(opts.bounds, opts.aimBox)) {
    if (!isTrackedByGate(state.gate, code, opts.candidatesOf)) {
      return { next: state, startResolving: null, indicator: null };
    }
    return {
      next: { ...state, gate: touchSeen(state.gate, code, now, opts.candidatesOf) },
      startResolving: null,
      indicator: null,
    };
  }

  // SA-384b: one absence gap for both the mark and its honour, on this path only.
  const repeat = opts.fastRepeat === true && hasBeenAccepted(state.gate, code, opts.candidatesOf);
  const absenceGap = repeat ? FAST_REPEAT_ABSENCE_GAP_MS : STEADY_ABSENCE_GAP_MS;
  const absent = isAbsentFromGate(state.gate, code, now, opts.candidatesOf, absenceGap);
  const tracked = trackSteadyRead(state.steady, code, now, absent);
  const { afterAbsence, next: nextSteady } = tracked;
  const steady = tracked.steady || (repeat && absent);

  if (!steady) {
    const nextGate = touchSeen(state.gate, code, now, opts.candidatesOf);
    return {
      next: { ...state, gate: nextGate, steady: nextSteady },
      startResolving: null,
      indicator: null,
    };
  }

  const gated = gateScan(
    code,
    state.gate,
    now,
    repeat ? FAST_REPEAT_COOLDOWN_MS : undefined,
    opts.candidatesOf,
    afterAbsence,
    absenceGap,
  );
  if (!gated.accept) {
    return {
      next: { ...state, gate: gated.state, steady: nextSteady },
      startResolving: null,
      indicator: null,
    };
  }
  const wasResolving = state.buffer.isResolving;
  const result = pushScan(state.buffer, code);
  return {
    next: {
      gate: gated.state,
      buffer: result.next,
      steady: clearAfterAbsence(nextSteady, code, opts.candidatesOf),
    },
    startResolving: result.startResolving,
    indicator: indicatorEdge(wasResolving, result.next.isResolving),
    ...(result.dropped && { dropped: true }),
  };
}

/**
 * Hold-to-scan RELEASE: drops the steady-read streaks (and nothing else) so a re-grab has to earn a fresh steady read,
 * instead of a stale 2-frame streak from before the release counting towards it. Gate and buffer are untouched: an item
 * already resolved stays deduped, a queued one stays queued.
 */
export function resetSteadyRead<S extends ContinuousScanState>(state: S): S {
  return { ...state, steady: createSteadyReadState() };
}

/**
 * The in-flight resolve settled — drain whatever the buffer queued. Generic over the
 * caller's own state shape (plain `ScanEngineState`, or `ContinuousScanState` with its
 * extra `steady` field) so a continuous-mode caller's `steady` streaks survive the spread
 * untouched instead of being widened away by a fixed `ScanEngineState` return type.
 */
export function scanSettled<S extends ScanEngineState>(state: S): ScanEngineStep & { next: S } {
  const wasResolving = state.buffer.isResolving;
  const result = completeResolve(state.buffer);
  return {
    next: { ...state, buffer: result.next },
    startResolving: result.startResolving,
    indicator: indicatorEdge(wasResolving, result.next.isResolving),
  };
}
