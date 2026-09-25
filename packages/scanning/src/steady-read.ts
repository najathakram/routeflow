/**
 * Scanner steady-read check (owner ruling 2026-09-24, see project memory
 * `project_scan_aimbox_hold_to_scan_2026-09-24`): DEFAULT ON alongside the aim box — a
 * decode counts only once the SAME value has been read at least `STEADY_READ_MIN_FRAMES`
 * times, all within `STEADY_READ_WINDOW_MS` of the streak's first frame. A single flicker
 * frame (a passing glance, a partially-occluded code) never counts; a genuinely held code
 * clears this in well under 300ms at typical camera frame rates.
 *
 * Deliberately RAW string equality, NOT the existing gate's symbology-normalized candidate
 * matching (`scan-loop.ts`'s `ScanCandidates`) — this check answers "is the camera holding
 * still on one value," not "is this the same physical item as one seen before." A label
 * that flickers between symbologies mid-hold resets the streak here, which is an
 * acceptable, rare cost for a filter whose job is rejecting RANDOM passing reads — cross-
 * symbology item identity is `scan-loop.ts`'s own, separate, downstream job.
 *
 * `steady` is true for EVERY frame once the streak reaches the threshold, not just the
 * one frame that first crosses it — a caller must keep handing every steady frame to the
 * existing gate (`scan-loop.ts`'s `gateScan`), because that gate's own `lastSeenAt` clock
 * needs to see every accepted-or-rejected frame to correctly measure the absence gap for a
 * deliberate re-scan (see `scan-engine.ts`'s own note: "every frame reaches the gate now").
 */

export const STEADY_READ_MIN_FRAMES = 3;
/** How long a streak may span and still count as "steady," in ms from its first frame. */
export const STEADY_READ_WINDOW_MS = 300;

export interface SteadyReadState {
  code: string | null;
  /** When the CURRENT streak's first frame was seen. */
  firstSeenAt: number;
  /** Consecutive frames (within the window) that decoded `code`. */
  count: number;
}

export interface SteadyReadResult {
  /** True once this streak has reached `STEADY_READ_MIN_FRAMES`, and stays true for every
   *  further frame of the same held code. */
  steady: boolean;
  next: SteadyReadState;
}

/** The empty/idle state — no streak started. */
export function createSteadyReadState(): SteadyReadState {
  return { code: null, firstSeenAt: 0, count: 0 };
}

/**
 * A frame decoded `code` at `now`. A different code, or a gap past `STEADY_READ_WINDOW_MS`
 * since the streak's own first frame, restarts the streak at count 1 — a streak's window
 * is anchored to its FIRST frame, not extended by each new one, so a code read just under
 * the limit every frame forever can never accumulate an unbounded streak.
 */
export function trackSteadyRead(
  state: SteadyReadState,
  code: string,
  now: number,
): SteadyReadResult {
  const continuesStreak = state.code === code && now - state.firstSeenAt <= STEADY_READ_WINDOW_MS;
  const next: SteadyReadState = continuesStreak
    ? { code, firstSeenAt: state.firstSeenAt, count: state.count + 1 }
    : { code, firstSeenAt: now, count: 1 };
  return { steady: next.count >= STEADY_READ_MIN_FRAMES, next };
}
